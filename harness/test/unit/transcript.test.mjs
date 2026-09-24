import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { TranscriptContent } from "../../dist/ui/transcript.js";

// Pi's components read a module-level theme singleton; no watcher in a test.
initTheme(undefined, false);

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

/** A pane over a fixed message list, read back as the text it would paint. */
const paneOver = (messages) => {
  const content = new TranscriptContent({ tui, cwd: "/w", markdownTheme: getMarkdownTheme(),
    source: { messages: () => messages, inFlight: () => undefined, toolDefinition: () => undefined } });
  return () => content.slice(80, 0, content.lineCount(80)).join("\n");
};

const call = (id, name = "bash") => ({ type: "toolCall", id, name, arguments: { command: "npm test" } });
const assistant = (content, extra = {}) => ({ role: "assistant", content, stopReason: "toolUse", ...extra });

test("a tool call still waiting for its result keeps rendering as pending", () => {
  const text = paneOver([assistant([call("t1")])])();
  assert.match(text, /npm test/, "the call itself is on screen");
  assert.doesNotMatch(text, /aborted|Error/i, "nothing has failed yet");
});

/**
 * Pi's assistant component prints no abort/error text when the message carries
 * tool calls -- it delegates that to the cards. A card that never finalizes
 * therefore spins forever AND swallows the only report of the failure.
 */
test("a call interrupted mid-generation finalizes instead of spinning forever", () => {
  const aborted = paneOver([assistant([call("t1")], { stopReason: "aborted" })])();
  assert.match(aborted, /Operation aborted/, "the abort is reported on the card Pi defers to");

  const failed = paneOver([assistant([call("t1")], { stopReason: "error", errorMessage: "overloaded_error" })])();
  assert.match(failed, /overloaded_error/, "a provider error reaches the card verbatim");

  const bare = paneOver([assistant([call("t1")], { stopReason: "error" })])();
  assert.match(bare, /Error/, "an error with no message still says so");
});

test("a result that does arrive still finalizes its own card and no other", () => {
  const text = paneOver([
    assistant([call("t1"), call("t2", "read")]),
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "TESTS_PASSED" }], isError: false },
  ])();
  // Once, on one card: applying a result to every pending call would print it
  // twice and finalize a read that is still waiting for its own answer.
  assert.equal(text.match(/TESTS_PASSED/g)?.length, 1, text);
  assert.match(text, /npm test/, "the answered call keeps its own header");
  assert.match(text, /read/, "and the unanswered one is still on screen");
  assert.doesNotMatch(text, /Operation aborted/);

  // The same list with nothing answered: the bash card carries no result, which
  // is what makes the single match above a real pin rather than an accident.
  const pending = paneOver([assistant([call("t1"), call("t2", "read")])])();
  assert.doesNotMatch(pending, /TESTS_PASSED/);
});
