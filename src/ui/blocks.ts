import { buildApprovalReplyExample } from "../domain/constants.ts";
import type { LaunchRecord, ReadinessState } from "../domain/types.ts";

type SlackBlock = Record<string, unknown>;

function stateEmoji(state: ReadinessState): string {
  switch (state) {
    case "green":
      return ":large_green_circle:";
    case "yellow":
      return ":large_yellow_circle:";
    case "red":
      return ":red_circle:";
    case "needs_review":
      return ":white_circle:";
  }
}

function stateLabel(state: ReadinessState): string {
  return `${stateEmoji(state)} ${state.replace("_", " ")}`;
}

function button(actionId: string, text: string, value: string, style?: "primary" | "danger"): SlackBlock {
  return {
    type: "button",
    action_id: actionId,
    text: {
      type: "plain_text",
      text
    },
    value,
    ...(style ? { style } : {})
  };
}

export function buildLaunchBlocks(launch: LaunchRecord, responseText = launch.decision.summary): SlackBlock[] {
  const topBlocker = launch.blockers.find((blocker) => blocker.status === "open");
  const missingApproval = launch.approvals.find((approval) => approval.state !== "approved");

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `GoSignal readiness: ${launch.name}`
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Updated ${new Date(launch.updatedAt).toLocaleString()}`
        },
        {
          type: "mrkdwn",
          text: `State: *${launch.decision.overallState}*`
        }
      ]
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommendation:* ${launch.decision.recommendation}\n*Summary:* ${responseText}\n*Next action:* ${launch.decision.nextAction}`
      }
    },
    {
      type: "section",
      fields: launch.categories.map((category) => ({
        type: "mrkdwn",
        text: `*${category.name}*\n${stateLabel(category.state)}`
      }))
    },
    ...(topBlocker
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Top blocker:* ${topBlocker.title}\n${topBlocker.description}`
            }
          } satisfies SlackBlock
        ]
      : []),
    ...(missingApproval
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Missing sign-off:* ${missingApproval.roleName}\n${missingApproval.reason}\n*Reply template:* \`${buildApprovalReplyExample(missingApproval.roleName)}\``
            }
          } satisfies SlackBlock
        ]
      : []),
    {
      type: "actions",
      elements: [
        button("gosignal_rerun", "Re-run readiness", launch.id, "primary"),
        button("gosignal_request_signoff", "Request sign-off", launch.id),
        button("gosignal_open_canvas", "Open launch brief", launch.id)
      ]
    }
  ];
}

export function buildLaunchBlocksWithResponse(launch: LaunchRecord, responseText: string): SlackBlock[] {
  return buildLaunchBlocks(launch, responseText);
}

export function buildDmReplyBlocks(launch: LaunchRecord, responseText = launch.decision.summary): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Here is the latest GoSignal view for *${launch.name}*.\n${responseText}`
      }
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*State*\n${stateLabel(launch.decision.overallState)}`
        },
        {
          type: "mrkdwn",
          text: `*Confidence*\n${launch.decision.confidence}`
        }
      ]
    },
    {
      type: "actions",
      elements: [
        button("gosignal_rerun", "Re-run readiness", launch.id, "primary"),
        button("gosignal_open_canvas", "Open launch brief", launch.id)
      ]
    }
  ];
}

export function buildSignoffRequestText(launch: LaunchRecord): string {
  const missingApproval = launch.approvals.find((approval) => approval.state !== "approved");
  if (!missingApproval) {
    return `GoSignal could not find a missing sign-off for ${launch.name}.`;
  }
  return `GoSignal still needs *${missingApproval.roleName}* before recommending green for *${launch.name}*. Please ask the owner to reply in this thread with a clear sign-off like: "${buildApprovalReplyExample(missingApproval.roleName)}"`;
}
