import type { App } from "@slack/bolt";
import type { ContextStore } from "../repositories/contextStore.ts";
import type { LaunchService } from "../services/launchService.ts";
import type { HomeService } from "../services/homeService.ts";
import { buildDmReplyBlocks, buildLaunchBlocks, buildSignoffRequestText } from "../ui/blocks.ts";
import type { AppContextSnapshot, LaunchRecord } from "../domain/types.ts";

interface GoSignalHandlersDependencies {
  contextStore: ContextStore;
  launchService: LaunchService;
  homeService: HomeService;
}

function extractActionToken(payload: Record<string, unknown>): string | undefined {
  const direct = payload.action_token;
  if (typeof direct === "string") {
    return direct;
  }
  const nested = payload.context;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).action_token === "string") {
    return (nested as Record<string, unknown>).action_token as string;
  }
  return undefined;
}

function extractContext(payload: Record<string, unknown>, workspaceId: string, userId: string): AppContextSnapshot {
  const appContext = (payload.app_context as Record<string, unknown> | undefined) ?? payload;
  const channel = appContext.channel as Record<string, unknown> | undefined;
  const message = appContext.message as Record<string, unknown> | undefined;

  return {
    workspaceId,
    userId,
    channelId:
      typeof appContext.channel_id === "string"
        ? appContext.channel_id
        : typeof channel?.id === "string"
          ? channel.id
          : undefined,
    threadTs:
      typeof appContext.thread_ts === "string"
        ? appContext.thread_ts
        : typeof message?.thread_ts === "string"
          ? message.thread_ts
          : typeof message?.ts === "string"
            ? message.ts
            : undefined,
    entityType: typeof appContext.type === "string" ? appContext.type : undefined,
    seenAt: new Date().toISOString()
  };
}

function extractActionThreadTarget(payload: Record<string, unknown>): { channelId?: string; threadTs?: string; userId?: string } {
  const container = payload.container as Record<string, unknown> | undefined;
  const channel = payload.channel as Record<string, unknown> | undefined;
  const message = payload.message as Record<string, unknown> | undefined;
  const user = payload.user as Record<string, unknown> | undefined;

  return {
    channelId:
      typeof container?.channel_id === "string"
        ? container.channel_id
        : typeof channel?.id === "string"
          ? channel.id
          : undefined,
    threadTs:
      typeof container?.thread_ts === "string"
        ? container.thread_ts
        : typeof message?.thread_ts === "string"
          ? message.thread_ts
          : typeof container?.message_ts === "string"
            ? container.message_ts
            : typeof message?.ts === "string"
              ? message.ts
              : undefined,
    userId: typeof user?.id === "string" ? user.id : undefined
  };
}

async function resolveLaunchFromAction(
  client: any,
  payload: Record<string, unknown>,
  workspaceId: string | undefined,
  launchService: LaunchService
): Promise<LaunchRecord | undefined> {
  const action = Array.isArray(payload.actions) ? payload.actions[0] as Record<string, unknown> | undefined : undefined;
  const launchId = action && typeof action.value === "string" ? action.value : undefined;

  if (launchId) {
    const existingLaunch = await launchService.getLaunchById(launchId);
    if (existingLaunch) {
      return existingLaunch;
    }
  }

  if (!workspaceId) {
    return undefined;
  }

  const actionTarget = extractActionThreadTarget(payload);
  if (!actionTarget.channelId || !actionTarget.threadTs || !actionTarget.userId) {
    return undefined;
  }

  return launchService.analyzeThread(client, {
    workspaceId,
    sourceChannelId: actionTarget.channelId,
    sourceThreadTs: actionTarget.threadTs,
    userId: actionTarget.userId,
    actionToken: extractActionToken(payload)
  });
}

export function registerHandlers(app: App, dependencies: GoSignalHandlersDependencies): void {
  app.event("app_home_opened", async (args) => {
    const { event, client, context, logger } = args as any;
    try {
      if (!context.teamId) {
        return;
      }
      await dependencies.homeService.publish(client, context.teamId, event.user);
    } catch (error) {
      logger.error(error);
    }
  });

  app.event("app_context_changed", async (args) => {
    const { event, context, logger } = args as any;
    try {
      if (!context.teamId) {
        return;
      }
      const payload = event as unknown as Record<string, unknown>;
      const userId = typeof payload.user === "string" ? payload.user : undefined;
      if (!userId) {
        return;
      }
      await dependencies.contextStore.set(extractContext(payload, context.teamId, userId));
    } catch (error) {
      logger.error(error);
    }
  });

  app.event("app_mention", async (args) => {
    const { event, client, context, logger, body } = args as any;
    try {
      if (!context.teamId) {
        return;
      }
      const actionToken = extractActionToken(body as Record<string, unknown>);
      const launch = await dependencies.launchService.analyzeThread(client, {
        workspaceId: context.teamId,
        sourceChannelId: event.channel,
        sourceThreadTs: event.thread_ts ?? event.ts,
        userId: event.user,
        actionToken
      });
      const responseText = await dependencies.launchService.answerLaunchQuestion(launch, event.text);

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: responseText,
        blocks: buildLaunchBlocks(launch, responseText) as never
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.shortcut("analyze_launch_readiness", async (args) => {
    const { shortcut, ack, client, context, logger, body } = args as any;
    await ack();

    try {
      if (!context.teamId) {
        return;
      }

      const channelId = shortcut.channel?.id;
      const messageTs = shortcut.message?.thread_ts ?? shortcut.message?.ts;
      if (!channelId || !messageTs) {
        return;
      }

      const actionToken = extractActionToken(body as Record<string, unknown>);
      const launch = await dependencies.launchService.analyzeThread(client, {
        workspaceId: context.teamId,
        sourceChannelId: channelId,
        sourceThreadTs: messageTs,
        userId: shortcut.user.id,
        actionToken
      });

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: launch.decision.summary,
        blocks: buildLaunchBlocks(launch) as never
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.event("message", async (args) => {
    const { event, client, context, logger } = args as any;
    try {
      const payload = event as Record<string, unknown>;
      if (!context.teamId || payload.channel_type !== "im" || typeof payload.user !== "string" || typeof payload.text !== "string") {
        return;
      }
      if (typeof payload.bot_id === "string") {
        return;
      }

      const snapshotFromEvent = (payload.app_context && typeof payload.app_context === "object")
        ? extractContext(payload, context.teamId, payload.user)
        : await dependencies.contextStore.get(context.teamId, payload.user);
      if (snapshotFromEvent && "seenAt" in snapshotFromEvent) {
        await dependencies.contextStore.set(snapshotFromEvent);
      }

      const launch = await dependencies.launchService.resolveLaunchForDmQuery({
        workspaceId: context.teamId,
        userId: payload.user,
        query: payload.text,
        context: snapshotFromEvent
      });

      if (!launch) {
        await client.chat.postMessage({
          channel: String(payload.channel),
          text: "GoSignal can answer about an existing launch after you analyze a thread. Use the message shortcut on a launch thread or mention @GoSignal in that thread first."
        });
        return;
      }

      const answerText = await dependencies.launchService.answerLaunchQuestion(launch, payload.text);

      await client.chat.postMessage({
        channel: String(payload.channel),
        thread_ts: typeof payload.thread_ts === "string" ? payload.thread_ts : String(payload.ts),
        text: answerText,
        blocks: buildDmReplyBlocks(launch, answerText) as never
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.action("gosignal_rerun", async (args) => {
    const { ack, body, client, logger, context } = args as any;
    await ack();
    try {
      const payload = body as Record<string, unknown>;
      const action = Array.isArray(body.actions) ? body.actions[0] : undefined;
      const launchId = action && typeof action.value === "string" ? action.value : undefined;
      const launch = launchId
        ? (await dependencies.launchService.rerunLaunch(client, launchId)) ??
          (await resolveLaunchFromAction(client, payload, context.teamId, dependencies.launchService))
        : await resolveLaunchFromAction(client, payload, context.teamId, dependencies.launchService);
      if (!launch) {
        return;
      }

      await client.chat.postMessage({
        channel: launch.sourceChannelId,
        thread_ts: launch.sourceThreadTs,
        text: launch.decision.summary,
        blocks: buildLaunchBlocks(launch) as never
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.action("gosignal_request_signoff", async (args) => {
    const { ack, body, client, logger, context } = args as any;
    await ack();
    try {
      const launch = await resolveLaunchFromAction(client, body as Record<string, unknown>, context.teamId, dependencies.launchService);
      if (!launch) {
        return;
      }

      await client.chat.postMessage({
        channel: launch.sourceChannelId,
        thread_ts: launch.sourceThreadTs,
        text: buildSignoffRequestText(launch)
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.action("gosignal_open_canvas", async (args) => {
    const { ack, body, client, logger, context } = args as any;
    await ack();
    try {
      const launch = await resolveLaunchFromAction(client, body as Record<string, unknown>, context.teamId, dependencies.launchService);
      if (!launch) {
        return;
      }

      await client.chat.postMessage({
        channel: launch.sourceChannelId,
        thread_ts: launch.sourceThreadTs,
        text: launch.canvasId
          ? `Launch brief ready: ${launch.canvasLinkLabel ?? launch.canvasId}`
          : "The launch brief canvas has not been created yet."
      });
    } catch (error) {
      logger.error(error);
    }
  });

  app.action("gosignal_open_launch", async (args) => {
    const { ack, body, client, logger, context } = args as any;
    await ack();
    try {
      const launch = await resolveLaunchFromAction(client, body as Record<string, unknown>, context.teamId, dependencies.launchService);
      if (!launch) {
        return;
      }
      await client.chat.postMessage({
        channel: launch.sourceChannelId,
        thread_ts: launch.sourceThreadTs,
        text: launch.decision.summary,
        blocks: buildLaunchBlocks(launch) as never
      });
    } catch (error) {
      logger.error(error);
    }
  });
}
