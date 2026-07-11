import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLaunchReadiness } from "../src/domain/readiness.ts";
import { buildDmReplyBlocks, buildLaunchBlocksWithResponse, buildSignoffRequestText } from "../src/ui/blocks.ts";

const launch = evaluateLaunchReadiness({
  key: {
    workspaceId: "T123",
    sourceChannelId: "C123",
    sourceThreadTs: "1000.0001"
  },
  name: "Mobile v3 launch",
  createdByUserId: "U123",
  threadMessages: [
    {
      channelId: "C123",
      threadTs: "1000.0001",
      messageTs: "1000.0001",
      text: "Ops lead approved and rollback documented. <@UOPS>",
      createdAt: "2026-07-09T09:00:00Z"
    }
  ],
  searchEvidence: [],
  now: new Date("2026-07-09T12:00:00Z")
});

test("buildLaunchBlocks includes action buttons", () => {
  const blocks = buildLaunchBlocksWithResponse(launch, "Custom answer");
  const actions = blocks.find((block) => block.type === "actions");
  assert.ok(actions);
});

test("buildDmReplyBlocks includes summary text", () => {
  const blocks = buildDmReplyBlocks(launch, "Natural reply");
  const section = blocks.find((block) => block.type === "section");
  assert.ok(section);
  assert.match(String((section as { text?: { text?: string } }).text?.text), /Natural reply/);
});

test("buildSignoffRequestText includes a concrete reply template", () => {
  const requestText = buildSignoffRequestText(launch);
  assert.match(requestText, /Engineering Lead approved for launch/);
});
