import type { WebClient } from "@slack/web-api";
import { buildSearchQuery, deriveLaunchName, evaluateLaunchReadiness } from "../domain/readiness.ts";
import type {
  AnalyzeThreadInput,
  AppContextSnapshot,
  DmResolutionInput,
  LaunchRecord,
  SearchEvidenceRecord,
  SlackMessageRecord
} from "../domain/types.ts";
import type { LaunchRepository } from "../repositories/launchRepository.ts";
import type { LLMProvider } from "./llmProvider.ts";
import type { CanvasGateway, SearchSource, ThreadSource } from "./slackSources.ts";
import { buildLaunchCanvasMarkdown } from "../ui/canvas.ts";

export interface LaunchServiceDependencies {
  repository: LaunchRepository;
  threadSource: ThreadSource;
  searchSource: SearchSource;
  canvasGateway: CanvasGateway;
  summaryProvider: LLMProvider;
}

export class LaunchService {
  private readonly dependencies: LaunchServiceDependencies;

  constructor(dependencies: LaunchServiceDependencies) {
    this.dependencies = dependencies;
  }

  async analyzeThread(client: WebClient, input: AnalyzeThreadInput): Promise<LaunchRecord> {
    const existingLaunch = await this.dependencies.repository.findByThread(input);
    const threadMessages = await this.dependencies.threadSource.fetchThread(client, input.sourceChannelId, input.sourceThreadTs);
    const launchName = deriveLaunchName(threadMessages, existingLaunch?.name);
    const searchQuery = buildSearchQuery(launchName);
    const searchEvidence = await this.dependencies.searchSource.searchPublicContext(client, {
      actionToken: input.actionToken,
      channelId: input.sourceChannelId,
      threadTs: input.sourceThreadTs,
      query: searchQuery
    });

    const launch = evaluateLaunchReadiness({
      key: input,
      name: launchName,
      createdByUserId: input.userId,
      threadMessages,
      searchEvidence,
      existingLaunch,
      searchQuery
    });
    launch.decision.summary = await this.dependencies.summaryProvider.summarizeLaunch(launch);

    const markdown = buildLaunchCanvasMarkdown(launch);
    const canvas = await this.dependencies.canvasGateway.createOrUpdate(
      client,
      launch.id,
      launch.canvasId,
      markdown,
      `Launch brief: ${launch.name}`
    );

    launch.canvasId = canvas.canvasId;
    launch.canvasLinkLabel = canvas.label;

    return this.dependencies.repository.save(launch);
  }

  async resolveLaunchForDmQuery(input: DmResolutionInput): Promise<LaunchRecord | undefined> {
    const byContext = await this.findLaunchFromContext(input.workspaceId, input.context);
    if (byContext) {
      return byContext;
    }

    const byName = await this.dependencies.repository.searchByName(input.workspaceId, input.query, 1);
    if (byName.length > 0) {
      return byName[0];
    }

    return this.dependencies.repository.findLatestByUser(input.workspaceId, input.userId);
  }

  async answerLaunchQuestion(launch: LaunchRecord, question: string): Promise<string> {
    return this.dependencies.summaryProvider.answerLaunchQuestion(launch, question);
  }

  async rerunLaunch(client: WebClient, launchId: string): Promise<LaunchRecord | undefined> {
    const launch = await this.dependencies.repository.findById(launchId);
    if (!launch) {
      return undefined;
    }

    return this.analyzeThread(client, {
      workspaceId: launch.workspaceId,
      sourceChannelId: launch.sourceChannelId,
      sourceThreadTs: launch.sourceThreadTs,
      userId: launch.createdByUserId
    });
  }

  async listRecentLaunches(workspaceId: string, limit = 5): Promise<LaunchRecord[]> {
    return this.dependencies.repository.listRecentForWorkspace(workspaceId, limit);
  }

  async getLaunchById(launchId: string): Promise<LaunchRecord | undefined> {
    return this.dependencies.repository.findById(launchId);
  }

  private async findLaunchFromContext(
    workspaceId: string,
    context: AppContextSnapshot | undefined
  ): Promise<LaunchRecord | undefined> {
    if (!context?.channelId || !context.threadTs) {
      return undefined;
    }

    return this.dependencies.repository.findByThread({
      workspaceId,
      sourceChannelId: context.channelId,
      sourceThreadTs: context.threadTs
    });
  }
}
