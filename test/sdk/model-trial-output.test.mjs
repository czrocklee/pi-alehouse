import assert from "node:assert/strict";
import test from "node:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { trialParentModel } from "../support/host.mjs";

test("live trial keeps the Codex catalogue budget in the request, including for a named slot", async () => {
  const catalog = {
    ...OPENAI_CODEX_MODELS["gpt-6.2-sol"],
    provider: "fixture-slot",
    baseUrl: "https://fixture.invalid",
  };
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
  ).toString("base64url");
  let payload;
  const result = await streamSimple(
    trialParentModel(catalog, false),
    { messages: [] },
    {
      apiKey: `fixture.${claims}.fixture`,
      reasoning: "low",
      onPayload(body) {
        payload = body;
        throw new Error("captured before transport");
      },
      transport: "sse",
      fetch: () => assert.fail("unexpected transport"),
      maxRetries: 0,
    },
  ).result();
  assert.match(result.errorMessage, /captured before transport/);
  assert(catalog.maxTokens > 2048);
  assert.equal(payload.max_output_tokens, catalog.maxTokens);
});

test("other live trial parents retain the override; the fixture and child catalogue stay untouched", () => {
  const catalog = Object.freeze({ provider: "fixture", api: "openai-responses", maxTokens: 8192 });
  assert.deepEqual(trialParentModel(catalog, false), { ...catalog, maxTokens: 2048 });
  assert.equal(trialParentModel(catalog, true), catalog);
  assert.equal(catalog.maxTokens, 8192);
});
