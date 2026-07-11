import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConfigWarnings,
  parseCerebrasReasoningEffort,
  describeResponseMode,
  extractAppIdFromAppToken,
  parseLLMProviderName,
  parseSlackCliAppId
} from "../src/config.ts";

test("extractAppIdFromAppToken returns the embedded app id for xapp tokens", () => {
  assert.equal(
    extractAppIdFromAppToken("xapp-1-A0BH56L2ETS-example-secret"),
    "A0BH56L2ETS"
  );
});

test("parseSlackCliAppId returns the first bound app id from apps.dev.json content", () => {
  assert.equal(
    parseSlackCliAppId(
      JSON.stringify({
        E123: {
          app_id: "A123",
          team_id: "T123"
        }
      })
    ),
    "A123"
  );
});

test("buildConfigWarnings flags a mismatch between the env app token and Slack CLI app binding", () => {
  const warnings = buildConfigWarnings(
    {
      SLACK_APP_TOKEN: "xapp-1-A0BG01PAS3V-example-secret"
    },
    "A0BH56L2ETS"
  );

  assert.equal(warnings.length, 1);
  const firstWarning = warnings[0];
  assert.ok(firstWarning);
  assert.match(firstWarning, /A0BG01PAS3V/);
  assert.match(firstWarning, /A0BH56L2ETS/);
});

test("buildConfigWarnings stays quiet when the app token matches the Slack CLI binding", () => {
  const warnings = buildConfigWarnings(
    {
      SLACK_APP_TOKEN: "xapp-1-A0BH56L2ETS-example-secret"
    },
    "A0BH56L2ETS"
  );

  assert.deepEqual(warnings, []);
});

test("parseLLMProviderName supports cerebras and defaults unknown values to deterministic", () => {
  assert.equal(parseLLMProviderName("cerebras"), "cerebras");
  assert.equal(parseLLMProviderName("something-else"), "deterministic");
});

test("buildConfigWarnings warns when cerebras is enabled without an API key", () => {
  const warnings = buildConfigWarnings(
    {
      ENABLE_LLM_SUMMARIES: "true",
      LLM_PROVIDER: "cerebras"
    },
    undefined
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /CEREBRAS_API_KEY/);
});

test("parseCerebrasReasoningEffort defaults unknown values to none", () => {
  assert.equal(parseCerebrasReasoningEffort("low"), "low");
  assert.equal(parseCerebrasReasoningEffort("HIGH"), "high");
  assert.equal(parseCerebrasReasoningEffort("mystery"), "none");
});

test("describeResponseMode reports cerebras when the provider is fully enabled", () => {
  assert.equal(
    describeResponseMode({
      enableLlmSummaries: true,
      llmProvider: "cerebras",
      cerebrasApiKey: "secret",
      cerebrasModel: "zai-glm-4.7"
    }),
    "cerebras (zai-glm-4.7)"
  );
});

test("describeResponseMode reports deterministic when llm summaries are disabled", () => {
  assert.equal(
    describeResponseMode({
      enableLlmSummaries: false,
      llmProvider: "deterministic",
      cerebrasApiKey: undefined,
      cerebrasModel: "gpt-oss-120b"
    }),
    "deterministic (LLM summaries disabled)"
  );
});
