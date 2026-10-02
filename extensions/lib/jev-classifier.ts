import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ClassifierContext, ClassifierModel, ClassifierResult, JsonObject } from "@earendil-works/pi-ai";

// This model belongs only to the permission reviewer. Do not register it in
// the host catalog or resolve the host's (possibly different) TypeSafe auth.
export const JEV_MODEL_ID = "jev-1.13.0";
export const JEV_MODEL: ClassifierModel<"typesafe-system-one"> = Object.freeze({
  type: "classifier",
  provider: "typesafe",
  id: JEV_MODEL_ID,
  name: "Jev permission reviewer",
  api: "typesafe-system-one",
  baseUrl: "https://api.typesafe.ai/v1/",
  input: ["text"] as Array<"text" | "image">,
  contextWindow: 64_000,
  // Required by the provider's local usage conversion; no price is known and
  // classifier usage is never merged into the parent's accounting ledger.
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
});
Object.freeze(JEV_MODEL.input);
export const JEV_ENDPOINT = new URL("systemone", JEV_MODEL.baseUrl).href;

// The provider is constructed only after a protected key and bounded packet
// exist; constructing it does not call its auth methods or ModelRuntime.
let classify: NonNullable<ReturnType<typeof builtinProviders>[number]["classify"]> | undefined;
function nativeClassifier() {
  if (!classify) {
    const provider = builtinProviders().find((candidate) => candidate.id === JEV_MODEL.provider);
    if (!provider?.classify) throw new Error("Native TypeSafe classifier unavailable");
    classify = provider.classify.bind(provider);
  }
  return classify;
}

export type NativeFailure = "cancelled" | "timeout" | "http_error" | "network_error" | "invalid_model_response";
export type NativeReview = {
  answers?: Record<string, { noul: number } | { score: number; confidence: number }>;
  failureCode?: NativeFailure;
  inputTokens?: number;
};

type WireQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: readonly string[] };

/** Native bool is the public form of wire noul; policy questions remain unchanged. */
export function nativeQuestions(questions: Record<string, WireQuestion>): ClassifierContext["questions"] {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [
    id, question.type === "noul" ? { ...question, type: "bool" } : { ...question, criteria: [...question.criteria] },
  ])) as ClassifierContext["questions"];
}

/** Reject wrong identity, missing/wrong-typed/invalid answers BEFORE policy composition. */
export function normalizedAnswers(result: ClassifierResult, questions: ClassifierContext["questions"]): NativeReview["answers"] | undefined {
  if (result.stopReason !== "stop" || result.provider !== JEV_MODEL.provider ||
      result.model !== JEV_MODEL.id || result.api !== JEV_MODEL.api ||
      !result.answers || typeof result.answers !== "object" || Array.isArray(result.answers)) return undefined;
  const answers: NonNullable<NativeReview["answers"]> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = result.answers[id];
    if (question.type === "bool") {
      if (answer?.type !== "bool" || !Number.isFinite(answer.probability) ||
          answer.probability < 0 || answer.probability > 1) return undefined;
      answers[id] = { noul: answer.probability };
    } else if (question.type === "score") {
      if (answer?.type !== "score" || !Number.isFinite(answer.score) ||
          answer.score < 0 || answer.score > question.criteria.length - 1 ||
          !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return undefined;
      answers[id] = { score: answer.score, confidence: answer.confidence };
    } else return undefined;
  }
  return Object.keys(result.answers).length === Object.keys(questions).length ? answers : undefined;
}

/** Internal transport: after dispatch, an aborted budget signal means timeout.
 * callJev separately maps its caller's withdrawal signal back to cancelled. */
export async function reviewWithNativeJev(
  packet: Record<string, unknown>, questions: Record<string, WireQuestion>, key: string,
  signal: AbortSignal,
): Promise<NativeReview> {
  if (signal.aborted) return { failureCode: "cancelled" };
  let status: number | undefined;
  let transportFailed = false;
  // Native classifier dispatch can await lazy imports before calling fetch.
  // Bind transport to THIS review: later overlapping/shadow reviews must not
  // inherit another request's swapped fetch implementation.
  const requestFetch = globalThis.fetch;
  const guardedFetch: typeof fetch = async (input, init) => {
    if (String(input) !== JEV_ENDPOINT || init?.redirect !== undefined && init.redirect !== "error") {
      transportFailed = true;
      throw new Error("Jev request rejected by endpoint guard");
    }
    try {
      // Explicitly forbid redirect-following; credentials and packet must not
      // leave this exact HTTPS endpoint, even on an HTTP 3xx response.
      const response = await requestFetch(input, { ...init, redirect: "error" });
      status = response.status;
      return response;
    } catch (error) {
      transportFailed = true;
      throw error;
    }
  };
  try {
    const result = await nativeClassifier()(JEV_MODEL, {
      state: packet as JsonObject,
      questions: nativeQuestions(questions),
    }, { apiKey: key, signal, maxRetries: 0, fetch: guardedFetch });
    // The SDK records usage before parsing answers: a malformed response may
    // still have been billed. Preserve that independent count even on defer,
    // without fabricating a parent cost or accepting the invalid answers.
    const input = result.usage?.input;
    const usage = typeof input === "number" && Number.isFinite(input) && input >= 0
      ? { inputTokens: input } : {};
    if (signal.aborted) return { ...usage, failureCode: "timeout" };
    if (status !== undefined && (status < 200 || status >= 300)) return { ...usage, failureCode: "http_error" };
    if (transportFailed) return { ...usage, failureCode: "network_error" };
    const answers = normalizedAnswers(result, nativeQuestions(questions));
    if (!answers || status === undefined) return { ...usage, failureCode: "invalid_model_response" };
    return { ...usage, answers };
  } catch {
    return { failureCode: signal.aborted ? "timeout" : "network_error" };
  }
}
