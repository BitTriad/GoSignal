import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLaunchReadiness } from "../src/domain/readiness.ts";
import { CerebrasLLMProvider, DeterministicSummaryProvider } from "../src/services/llmProvider.ts";

const sampleLaunch = evaluateLaunchReadiness({
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
      text: "Engineering lead approved. <@UENG>",
      createdAt: "2026-07-09T09:00:00Z"
    },
    {
      channelId: "C123",
      threadTs: "1000.0001",
      messageTs: "1000.0002",
      text: "QA lead signed off. <@UQA>",
      createdAt: "2026-07-09T09:01:00Z"
    },
    {
      channelId: "C123",
      threadTs: "1000.0001",
      messageTs: "1000.0003",
      text: "Ops lead approved and rollback documented. <@UOPS>",
      createdAt: "2026-07-09T09:02:00Z"
    }
  ],
  searchEvidence: [],
  now: new Date("2026-07-09T12:00:00Z")
});

test("deterministic provider answers approval questions with the missing role", async () => {
  const provider = new DeterministicSummaryProvider();
  const answer = await provider.answerLaunchQuestion(sampleLaunch, "Who is missing?");

  assert.match(answer, /Support readiness/i);
});

test("cerebras provider falls back to deterministic answers when fetch fails", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const provider = new CerebrasLLMProvider({
    apiKey: "test-key",
    model: "gpt-oss-120b",
    baseUrl: "https://api.cerebras.ai/v1",
    fallback: new DeterministicSummaryProvider(),
    timeoutMs: 10
  });

  const answer = await provider.answerLaunchQuestion(sampleLaunch, "Are we ready?");
  assert.match(answer, /Mobile v3 launch is currently yellow/i);
});

test("cerebras provider sends reasoning_effort none when configured", async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Ready to launch."
            }
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const provider = new CerebrasLLMProvider({
    apiKey: "test-key",
    model: "zai-glm-4.7",
    baseUrl: "https://api.cerebras.ai/v1",
    reasoningEffort: "none",
    fallback: new DeterministicSummaryProvider(),
    timeoutMs: 10
  });

  const answer = await provider.answerLaunchQuestion(sampleLaunch, "Are we ready?");
  assert.equal(answer, "Ready to launch.");
  assert.equal(capturedBody?.reasoning_effort, "none");
});
