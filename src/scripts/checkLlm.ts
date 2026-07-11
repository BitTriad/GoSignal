import { randomUUID } from "node:crypto";
import { describeResponseMode, loadConfig } from "../config.ts";
import type { LaunchRecord } from "../domain/types.ts";
import { CerebrasLLMProvider, type LLMProvider } from "../services/llmProvider.ts";

class TrackingFallbackProvider implements LLMProvider {
  public used = false;

  async summarizeLaunch(): Promise<string> {
    this.used = true;
    return "[[fallback summary]]";
  }

  async answerLaunchQuestion(): Promise<string> {
    this.used = true;
    return "[[fallback answer]]";
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`GoSignal response mode: ${describeResponseMode(config)}`);

  if (!config.enableLlmSummaries) {
    throw new Error("ENABLE_LLM_SUMMARIES is false. Set it to true before running this check.");
  }

  if (config.llmProvider !== "cerebras") {
    throw new Error(`LLM_PROVIDER must be cerebras for this check. Current value: ${config.llmProvider}`);
  }

  if (!config.cerebrasApiKey) {
    throw new Error("CEREBRAS_API_KEY is missing.");
  }

  const fallback = new TrackingFallbackProvider();
  const provider = new CerebrasLLMProvider({
    apiKey: config.cerebrasApiKey,
    model: config.cerebrasModel,
    baseUrl: config.cerebrasBaseUrl,
    reasoningEffort: config.cerebrasReasoningEffort,
    fallback,
    timeoutMs: 15_000
  });

  const launch = buildSampleLaunch();

  const summary = await provider.summarizeLaunch(launch);
  const answer = await provider.answerLaunchQuestion(launch, "Are we ready to launch?");

  if (fallback.used) {
    throw new Error(
      "The Cerebras provider fell back to deterministic output. Check the logs above for the API error."
    );
  }

  console.log("\nSummary preview:\n");
  console.log(summary);
  console.log("\nAnswer preview:\n");
  console.log(answer);
  console.log(`\nCerebras health check passed for model ${config.cerebrasModel}.`);
}

function buildSampleLaunch(): LaunchRecord {
  const now = new Date().toISOString();
  const key = {
    workspaceId: "W-check",
    sourceChannelId: "C-check",
    sourceThreadTs: "1720000000.000100"
  };

  return {
    ...key,
    id: randomUUID(),
    name: "Mobile v3 checkout rollout",
    createdByUserId: "U-check",
    status: "active",
    categories: [
      buildCategory("Engineering", "green", "high", "Engineering lead confirmed rollout readiness."),
      buildCategory("Quality", "green", "high", "QA signed off after final regression pass."),
      buildCategory("Operations", "yellow", "medium", "Support readiness is still pending final confirmation."),
      buildCategory("Comms", "green", "medium", "Customer comms draft is ready for release."),
      buildCategory("Approvals", "yellow", "medium", "Support readiness sign-off is still missing."),
      buildCategory("Dependencies", "green", "medium", "No critical dependency issues are open.")
    ],
    approvals: [
      {
        roleName: "engineering lead",
        state: "approved",
        approverUserId: "U-eng",
        evidenceIds: ["ev-eng-1"],
        reason: "Engineering lead approved the rollout for launch."
      },
      {
        roleName: "qa lead",
        state: "approved",
        approverUserId: "U-qa",
        evidenceIds: ["ev-qa-1"],
        reason: "QA lead signed off after the final pass."
      },
      {
        roleName: "support readiness",
        state: "missing",
        evidenceIds: ["ev-support-1"],
        reason: "Support readiness approval has not been explicitly posted yet."
      }
    ],
    blockers: [],
    evidence: [
      buildEvidence("ev-eng-1", "Engineering", "Engineering lead approved the rollout for launch.", 92),
      buildEvidence("ev-qa-1", "Quality", "QA lead signed off after final regression pass.", 89),
      buildEvidence("ev-support-1", "Approvals", "Waiting on support readiness approval before go-live.", 84)
    ],
    decision: {
      id: randomUUID(),
      takenAt: now,
      overallState: "yellow",
      confidence: "medium",
      recommendation: "Proceed with caution.",
      summary:
        "Mobile v3 checkout rollout is yellow because support readiness approval is still missing.",
      nextAction: "Request support readiness approval and rerun GoSignal once it lands.",
      rationale: [
        "Engineering and QA approvals are explicit.",
        "Support readiness is still missing.",
        "No explicit blockers or rollback gaps are open."
      ],
      blockerIds: []
    },
    searchQuery: "launch readiness mobile v3 checkout rollout",
    createdAt: now,
    updatedAt: now
  };
}

function buildCategory(
  name: string,
  state: "green" | "yellow" | "red" | "needs_review",
  confidence: "low" | "medium" | "high",
  summary: string
) {
  return {
    name,
    state,
    confidence,
    blockerCount: 0,
    missingApprovalRoles: [],
    evidenceIds: [],
    summary
  };
}

function buildEvidence(id: string, categoryName: string, text: string, score: number) {
  return {
    id,
    sourceType: "thread_message" as const,
    title: categoryName,
    text,
    summary: text,
    categoryName,
    freshness: "fresh" as const,
    score,
    severity: "medium" as const,
    signals: {
      explicitHold: false,
      blocker: false,
      rollbackMissing: false,
      rollbackReady: true,
      unresolvedIssue: false,
      resolvedIssue: true,
      dependencyRisk: false,
      ambiguous: false,
      positiveApprovalRoles: [],
      missingApprovalRoles: [],
      ownerUserIds: []
    }
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
