import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LLMProviderName = "deterministic" | "cerebras";
export type CerebrasReasoningEffort = "none" | "low" | "medium" | "high";

export interface AppConfig {
  port: number;
  slackSigningSecret: string;
  slackBotToken: string;
  slackAppToken: string | undefined;
  databaseUrl: string | undefined;
  useSocketMode: boolean;
  enableLlmSummaries: boolean;
  llmProvider: LLMProviderName;
  cerebrasApiKey: string | undefined;
  cerebrasModel: string;
  cerebrasBaseUrl: string;
  cerebrasReasoningEffort: CerebrasReasoningEffort;
  warnings: string[];
}

export function describeResponseMode(
  config: Pick<AppConfig, "enableLlmSummaries" | "llmProvider" | "cerebrasApiKey" | "cerebrasModel">
): string {
  if (!config.enableLlmSummaries) {
    return "deterministic (LLM summaries disabled)";
  }

  if (config.llmProvider === "cerebras" && config.cerebrasApiKey) {
    return `cerebras (${config.cerebrasModel})`;
  }

  if (config.llmProvider === "cerebras") {
    return "deterministic (Cerebras requested but API key missing)";
  }

  return "deterministic";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseLLMProviderName(value: string | undefined): LLMProviderName {
  return value?.trim().toLowerCase() === "cerebras" ? "cerebras" : "deterministic";
}

export function parseCerebrasReasoningEffort(value: string | undefined): CerebrasReasoningEffort {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "none";
}

export function extractAppIdFromAppToken(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }

  const parts = token.split("-");
  if (parts[0] !== "xapp" || parts.length < 3 || !parts[2]) {
    return undefined;
  }

  return parts[2];
}

export function parseSlackCliAppId(payload: string): string | undefined {
  try {
    const apps = JSON.parse(payload) as Record<string, { app_id?: unknown }>;
    for (const app of Object.values(apps)) {
      if (app && typeof app.app_id === "string") {
        return app.app_id;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function loadSlackCliBoundAppId(): string | undefined {
  const appsDevPath = join(process.cwd(), ".slack", "apps.dev.json");
  if (!existsSync(appsDevPath)) {
    return undefined;
  }

  try {
    return parseSlackCliAppId(readFileSync(appsDevPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function buildConfigWarnings(
  env: NodeJS.ProcessEnv,
  slackCliAppId: string | undefined
): string[] {
  const warnings: string[] = [];
  const tokenAppId = extractAppIdFromAppToken(env.SLACK_APP_TOKEN);
  const llmProvider = parseLLMProviderName(env.LLM_PROVIDER);
  const requestedProvider = env.LLM_PROVIDER?.trim().toLowerCase();
  const llmEnabled = parseBoolean(env.ENABLE_LLM_SUMMARIES, false);
  const requestedReasoningEffort = env.CEREBRAS_REASONING_EFFORT?.trim().toLowerCase();

  if (slackCliAppId && tokenAppId && slackCliAppId !== tokenAppId) {
    warnings.push(
      `SLACK_APP_TOKEN targets app ${tokenAppId}, but this Slack CLI project is bound to app ${slackCliAppId}. ` +
        "If you want triggers from the new sandbox app, run with Slack CLI or update SLACK_BOT_TOKEN, " +
        "SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET to the new app."
    );
  }

  if (requestedProvider && requestedProvider !== "deterministic" && requestedProvider !== "cerebras") {
    warnings.push(
      `LLM_PROVIDER=${env.LLM_PROVIDER} is not recognized. Falling back to deterministic responses.`
    );
  }

  if (llmEnabled && llmProvider === "cerebras" && !env.CEREBRAS_API_KEY) {
    warnings.push(
      "ENABLE_LLM_SUMMARIES=true and LLM_PROVIDER=cerebras, but CEREBRAS_API_KEY is missing. Falling back to deterministic responses."
    );
  }

  if (
    requestedReasoningEffort &&
    !["none", "low", "medium", "high"].includes(requestedReasoningEffort)
  ) {
    warnings.push(
      `CEREBRAS_REASONING_EFFORT=${env.CEREBRAS_REASONING_EFFORT} is not recognized. Falling back to none.`
    );
  }

  return warnings;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    slackSigningSecret: requireEnv("SLACK_SIGNING_SECRET"),
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackAppToken: process.env.SLACK_APP_TOKEN,
    databaseUrl: process.env.DATABASE_URL,
    useSocketMode: parseBoolean(process.env.USE_SOCKET_MODE, false),
    enableLlmSummaries: parseBoolean(process.env.ENABLE_LLM_SUMMARIES, false),
    llmProvider: parseLLMProviderName(process.env.LLM_PROVIDER),
    cerebrasApiKey: process.env.CEREBRAS_API_KEY,
    cerebrasModel: process.env.CEREBRAS_MODEL ?? "gpt-oss-120b",
    cerebrasBaseUrl: process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1",
    cerebrasReasoningEffort: parseCerebrasReasoningEffort(process.env.CEREBRAS_REASONING_EFFORT),
    warnings: buildConfigWarnings(process.env, loadSlackCliBoundAppId())
  };
}
