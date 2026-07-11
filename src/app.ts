import { App } from "@slack/bolt";
import type { AppConfig } from "./config.ts";
import { MemoryContextStore } from "./repositories/contextStore.ts";
import { MemoryLaunchRepository } from "./repositories/memoryLaunchRepository.ts";
import { PostgresLaunchRepository } from "./repositories/postgresLaunchRepository.ts";
import type { LaunchRepository } from "./repositories/launchRepository.ts";
import { registerHandlers } from "./handlers/registerHandlers.ts";
import { HomeService } from "./services/homeService.ts";
import { LaunchService } from "./services/launchService.ts";
import { CerebrasLLMProvider, DeterministicSummaryProvider, type LLMProvider } from "./services/llmProvider.ts";
import { SlackCanvasGateway, SlackSearchSource, SlackThreadSource } from "./services/slackSources.ts";

export async function createGoSignalApp(config: AppConfig): Promise<{ app: App; repository: LaunchRepository }> {
  const repository = config.databaseUrl
    ? new PostgresLaunchRepository(config.databaseUrl)
    : new MemoryLaunchRepository();

  if (repository instanceof PostgresLaunchRepository) {
    await repository.initialize();
  }

  if (config.useSocketMode && !config.slackAppToken) {
    throw new Error("SLACK_APP_TOKEN is required when USE_SOCKET_MODE=true");
  }

  const summaryProvider = createSummaryProvider(config);

  const appOptions = {
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
    socketMode: config.useSocketMode
  } as {
    token: string;
    signingSecret: string;
    socketMode: boolean;
    appToken?: string;
  };
  if (config.slackAppToken) {
    appOptions.appToken = config.slackAppToken;
  }

  const app = new App(appOptions);

  const launchService = new LaunchService({
    repository,
    threadSource: new SlackThreadSource(),
    searchSource: new SlackSearchSource(),
    canvasGateway: new SlackCanvasGateway(),
    summaryProvider
  });

  registerHandlers(app, {
    contextStore: new MemoryContextStore(),
    launchService,
    homeService: new HomeService(launchService)
  });

  return {
    app,
    repository
  };
}

function createSummaryProvider(config: AppConfig): LLMProvider {
  const deterministic = new DeterministicSummaryProvider();

  if (!config.enableLlmSummaries) {
    return deterministic;
  }

  if (config.llmProvider === "cerebras" && config.cerebrasApiKey) {
    return new CerebrasLLMProvider({
      apiKey: config.cerebrasApiKey,
      model: config.cerebrasModel,
      baseUrl: config.cerebrasBaseUrl,
      reasoningEffort: config.cerebrasReasoningEffort,
      fallback: deterministic
    });
  }

  return deterministic;
}
