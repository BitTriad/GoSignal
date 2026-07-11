import type { LaunchRecord } from "../domain/types.ts";

export interface LLMProvider {
  summarizeLaunch(launch: LaunchRecord): Promise<string>;
  answerLaunchQuestion(launch: LaunchRecord, question: string): Promise<string>;
}

export class DeterministicSummaryProvider implements LLMProvider {
  async summarizeLaunch(launch: LaunchRecord): Promise<string> {
    return buildDeterministicSummary(launch);
  }

  async answerLaunchQuestion(launch: LaunchRecord, question: string): Promise<string> {
    return buildDeterministicAnswer(launch, question);
  }
}

interface CerebrasProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  fallback: LLMProvider;
  timeoutMs?: number;
}

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export class CerebrasLLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly reasoningEffort: "none" | "low" | "medium" | "high";
  private readonly fallback: LLMProvider;
  private readonly timeoutMs: number;

  constructor(options: CerebrasProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.reasoningEffort = options.reasoningEffort ?? "none";
    this.fallback = options.fallback;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  async summarizeLaunch(launch: LaunchRecord): Promise<string> {
    try {
      return await this.complete([
        {
          role: "system",
          content:
            "You are GoSignal, a launch readiness assistant. Use only the structured launch data provided. " +
            "Never invent approvals, blockers, evidence, or a different readiness state. Keep answers concise and workplace-ready."
        },
        {
          role: "user",
          content:
            "Write a natural Slack-ready launch summary in 2 to 4 sentences. Mention the overall state, the main reason, " +
            "any open blocker or missing sign-off if present, and the next action. Keep it under 90 words.\n\n" +
            buildLaunchContext(launch)
        }
      ], 140);
    } catch (error) {
      console.warn("[GoSignal warning] Cerebras summary generation failed. Falling back to deterministic summary.", error);
      return this.fallback.summarizeLaunch(launch);
    }
  }

  async answerLaunchQuestion(launch: LaunchRecord, question: string): Promise<string> {
    try {
      return await this.complete([
        {
          role: "system",
          content:
            "You are GoSignal, a launch readiness assistant. Answer naturally but stay grounded in the launch data only. " +
            "Do not guess. If the question asks for something the data does not support, say that GoSignal does not have enough evidence yet."
        },
        {
          role: "user",
          content:
            `User question: ${question}\n\n` +
            "Answer in 2 to 5 sentences. Mention the overall state when relevant, then explain the evidence-backed reason and the next action.\n\n" +
            buildLaunchContext(launch)
        }
      ], 220);
    } catch (error) {
      console.warn("[GoSignal warning] Cerebras question answering failed. Falling back to deterministic answer.", error);
      return this.fallback.answerLaunchQuestion(launch, question);
    }
  }

  private async complete(messages: ChatMessage[], maxCompletionTokens: number): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        max_completion_tokens: maxCompletionTokens,
        reasoning_effort: this.reasoningEffort
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Cerebras request failed with ${response.status} ${response.statusText}: ${details}`);
    }

    const payload = await response.json() as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: unknown;
          reasoning?: unknown;
        };
      }>;
    };

    const firstChoice = payload.choices?.[0];
    const content = extractContent(firstChoice?.message?.content);
    if (!content) {
      if (typeof firstChoice?.message?.reasoning === "string" && firstChoice.finish_reason === "length") {
        throw new Error(
          "Cerebras used the entire completion budget on reasoning and returned no final content. " +
            "Use a lower reasoning effort or increase max_completion_tokens."
        );
      }
      throw new Error("Cerebras response did not include message content.");
    }

    return normalizeWhitespace(content);
  }
}

function buildDeterministicSummary(launch: LaunchRecord): string {
    const topBlocker = launch.blockers.find((blocker) => blocker.status === "open");
  const pendingApprovals = launch.approvals.filter((approval) => approval.state !== "approved");
  const nonGreenCategories = launch.categories.filter((category) => category.state !== "green");

  const lines = [`${launch.name} is ${launch.decision.overallState}.`, launch.decision.recommendation];

  if (topBlocker) {
    lines.push(`Top blocker: ${topBlocker.title}.`);
  } else if (pendingApprovals.length > 0) {
    lines.push(`Still waiting on ${joinHumanList(pendingApprovals.map((approval) => approval.roleName))}.`);
  } else if (nonGreenCategories.length > 0) {
    lines.push(`Remaining watch areas: ${joinHumanList(nonGreenCategories.map((category) => category.name))}.`);
  }

  lines.push(`Next action: ${launch.decision.nextAction}`);

  return normalizeWhitespace(lines.join(" "));
}

function buildDeterministicAnswer(launch: LaunchRecord, question: string): string {
  const normalizedQuestion = question.toLowerCase();
  const topBlocker = launch.blockers.find((blocker) => blocker.status === "open");
  const pendingApprovals = launch.approvals.filter((approval) => approval.state !== "approved");
  const nonGreenCategories = launch.categories.filter((category) => category.state !== "green");

  if (/(sign-?off|approval|approve|missing|who.*(approve|sign))/i.test(normalizedQuestion)) {
    if (pendingApprovals.length === 0) {
      return normalizeWhitespace(
        `All required sign-offs are currently present for ${launch.name}. ` +
          `${launch.decision.recommendation} Next action: ${launch.decision.nextAction}`
      );
    }

    const firstPendingApproval = pendingApprovals[0]!;
    return normalizeWhitespace(
      `${launch.name} is still waiting on ${joinHumanList(pendingApprovals.map((approval) => approval.roleName))}. ` +
        `${firstPendingApproval.reason} Next action: ${launch.decision.nextAction}`
    );
  }

  if (/(block|risk|issue|hold|holding|problem)/i.test(normalizedQuestion)) {
    if (topBlocker) {
      return normalizeWhitespace(
        `The main blocker for ${launch.name} is ${topBlocker.title}. ${topBlocker.description} ` +
          `GoSignal currently sees the launch as ${launch.decision.overallState}. Next action: ${launch.decision.nextAction}`
      );
    }

    if (pendingApprovals.length > 0) {
      return normalizeWhitespace(
        `There is no explicit open blocker in the current evidence, but ${launch.name} is still held by missing sign-off from ` +
          `${joinHumanList(pendingApprovals.map((approval) => approval.roleName))}. Next action: ${launch.decision.nextAction}`
      );
    }

    return normalizeWhitespace(
      `GoSignal does not see an explicit open blocker for ${launch.name} right now. ` +
        `${launch.decision.recommendation} Next action: ${launch.decision.nextAction}`
    );
  }

  if (/(next|do now|what should|what now|action)/i.test(normalizedQuestion)) {
    return normalizeWhitespace(
      `Next action for ${launch.name}: ${launch.decision.nextAction} ` +
        `Current state is ${launch.decision.overallState}, and the recommendation is ${launch.decision.recommendation.toLowerCase()}`
    );
  }

  if (/(ready|launch|ship|status|go live|go-ahead|can we)/i.test(normalizedQuestion)) {
    const watchAreas =
      nonGreenCategories.length > 0 ? ` Watch areas: ${joinHumanList(nonGreenCategories.map((category) => category.name))}.` : "";
    return normalizeWhitespace(
      `${launch.name} is currently ${launch.decision.overallState}. ${launch.decision.recommendation} ` +
        `${launch.decision.nextAction}.${watchAreas}`
    );
  }

  return normalizeWhitespace(
    `${buildDeterministicSummary(launch)} ${launch.decision.summary !== buildDeterministicSummary(launch) ? launch.decision.summary : ""}`
  );
}

function buildLaunchContext(launch: LaunchRecord): string {
  const categories = launch.categories
    .map((category) => `- ${category.name}: ${category.state} (${category.confidence}) — ${category.summary}`)
    .join("\n");
  const approvals = launch.approvals
    .map((approval) => `- ${approval.roleName}: ${approval.state} — ${approval.reason}`)
    .join("\n");
  const blockers =
    launch.blockers.length > 0
      ? launch.blockers
          .map((blocker) => `- ${blocker.title} [${blocker.status}/${blocker.severity}] — ${blocker.description}`)
          .join("\n")
      : "- None";
  const evidence = launch.evidence
    .slice()
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map((item) => `- ${item.categoryName}: ${truncate(item.summary || item.text, 220)}`)
    .join("\n");

  return [
    `Launch: ${launch.name}`,
    `Overall state: ${launch.decision.overallState}`,
    `Confidence: ${launch.decision.confidence}`,
    `Recommendation: ${launch.decision.recommendation}`,
    `Next action: ${launch.decision.nextAction}`,
    "Categories:",
    categories || "- None",
    "Approvals:",
    approvals || "- None",
    "Blockers:",
    blockers,
    "Top evidence:",
    evidence || "- None"
  ].join("\n");
}

function extractContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");

    return text || undefined;
  }

  return undefined;
}

function joinHumanList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0]!;
  }
  if (items.length === 2) {
    return `${items[0]!} and ${items[1]!}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]!}`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
