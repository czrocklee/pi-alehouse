// Researcher web isolation with the pinned pi-web-access build and the real
// development SDK validator. No credentials, network or model: factories only
// register tools against recording APIs, and no tool is executed on the web.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ChildWebModules, childWebExtension, nativeWebLoader, researcherWebProblem } from "../../dist/runtime/child-web.js";
import { researcherHostModules } from "../../dist/runtime/host-modules.js";
import { webToolNames } from "../../dist/tools/tool-names.js";
import { productionWebLayout } from "../support/production-web.mjs";

// pi-web-access reads user configuration from the home directory; never the real one.
const home = mkdtempSync(join(tmpdir(), "harness-child-web-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
test.after(() => rmSync(home, { recursive: true, force: true }));

const entry = join(dirname(createRequire(import.meta.url).resolve("pi-web-access/package.json")), "dist/index.js");
// In these native tests, the development SDK stands in for the host modules.
const load = nativeWebLoader(researcherHostModules);

function recordingApi() {
  const tools = new Map(), messages = [];
  const api = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: () => {}, registerShortcut: () => {}, on: () => {}, appendEntry: () => {},
    getAllTools: () => [...tools.values()], getActiveTools: () => [...tools.keys()], setActiveTools: () => {},
    sendMessage: (message, options) => { messages.push({ message, options }); },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  return { api, tools, messages };
}

test("each open researcher session gets an isolated, reusable pi-web-access instance", async () => {
  const parent = (await import(pathToFileURL(entry).href)).default;
  const modules = new ChildWebModules(entry, load);
  const [a, b] = await Promise.all([modules.acquire(), modules.acquire()]);
  assert.notEqual(a.factory, b.factory);
  for (const lease of [a, b]) assert.notEqual(lease.factory, parent, "never the parent's module state");
  a.release(); a.release();
  const c = await modules.acquire();
  assert.equal(c.factory, a.factory, "a released instance is reused, not leaked");
  const d = await modules.acquire();
  assert.notEqual(d.factory, a.factory);
  assert.notEqual(d.factory, b.factory);
});

test("a production install without the Pi SDK gets isolated instances through the host modules", async () => {
  const layout = mkdtempSync(join(tmpdir(), "harness-production-web-"));
  try {
    const copied = productionWebLayout(layout, entry);
    const modules = new ChildWebModules(copied, load);
    const [a, b] = await Promise.all([modules.acquire(), modules.acquire()]);
    assert.notEqual(a.factory, b.factory);
    const { api, tools } = recordingApi();
    await childWebExtension(a.factory)(api);
    assert.deepEqual([...tools.keys()].sort(), [...webToolNames].sort());
  } finally { rmSync(layout, { recursive: true, force: true }); }
});

test("bridged imports are exactly the supplied host objects; unsupplied host modules fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-host-bridge-"));
  try {
    mkdirSync(join(directory, "probe"));
    writeFileSync(join(directory, "probe/package.json"), '{"type":"module"}');
    writeFileSync(join(directory, "probe/index.js"), `import * as agent from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export { agent, Type };
export const compat = () => import("@earendil-works/pi-ai/compat");
export const unsupplied = () => import("@earendil-works/pi-agent-core");`);
    const href = pathToFileURL(join(directory, "probe/index.js")).href;
    const host = (marker) => ({ "@earendil-works/pi-coding-agent": { marker, default: marker }, typebox: { Type: marker },
      "@earendil-works/pi-ai/compat": { complete: marker } });
    const first = { id: "first" }, second = { id: "second" };
    const firstHost = host(first);
    const probe = await nativeWebLoader(firstHost)(href);
    assert.equal(probe.agent.marker, first);
    assert.equal(probe.agent.default, first);
    assert.equal(probe.Type, first);
    assert.equal((await probe.compat()).complete, first);
    await assert.rejects(probe.unsupplied(), /pi-agent-core, which the harness does not supply/);
    // New host objects (a harness reload) are never shadowed by cached ones.
    const again = await nativeWebLoader(host(second))(href);
    assert.equal(again.agent.marker, second);
    assert.equal((await nativeWebLoader({ ...firstHost })(href)).agent, probe.agent, "the same objects reuse their generation");
    await assert.rejects(nativeWebLoader({ "not-host": {} })(href), /Not a host module/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("supported dynamic activation never changes the researcher's fixed tool table", async () => {
  const config = join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
  mkdirSync(dirname(config), { recursive: true });
  try {
    for (const mode of ["auto", "dynamic", "eager"]) {
      writeFileSync(config, JSON.stringify({ toolActivation: mode }));
      const { factory } = await new ChildWebModules(entry, load).acquire();
      const { api, tools } = recordingApi(), handlers = new Map(), changes = [];
      api.on = (event, handler) => {
        const set = handlers.get(event) ?? new Set(); set.add(handler); handlers.set(event, set);
        return () => set.delete(handler);
      };
      api.setActiveTools = (names) => changes.push([...names]);
      await childWebExtension(factory)(api);
      assert.deepEqual([...tools.keys()].sort(), [...webToolNames].sort(), mode);
      const ctx = { sessionManager: SessionManager.inMemory(home), model: { api: "openai-responses", compat: {
        supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
      } } };
      for (const event of ["session_start", "session_tree", "before_agent_start"]) {
        for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
      }
      assert.deepEqual(changes, [], `${mode}: dropped loader must prevent activation handlers changing child tools`);
    }
  } finally { rmSync(config, { force: true }); }
});

test("a loader that collapses the instance query fails closed", async () => {
  const factory = () => {};
  const modules = new ChildWebModules(entry, async () => ({ default: factory }));
  await assert.rejects(modules.acquire(), /not an isolated instance/);
});

test("the real schemas reject auth, proxy and non-http(s) URLs before any prompt", async () => {
  const { factory } = await new ChildWebModules(entry, load).acquire();
  const { api, tools } = recordingApi();
  await childWebExtension(factory)(api);
  assert.deepEqual([...tools.keys()].sort(), [...webToolNames].sort(), "no web_enable loader");
  const validate = (name, args) => validateToolArguments(tools.get(name), { type: "toolCall", id: "t", name, arguments: args });
  const fetch = tools.get("fetch_content");
  for (const key of ["auth", "proxy"]) assert.equal(key in fetch.parameters.properties, false, key);
  assert.deepEqual(validate("fetch_content", { url: "https://example.com/a" }), { url: "https://example.com/a" });
  assert.deepEqual(validate("fetch_content", { urls: ["http://example.com/a", "HTTPS://example.com/b"] }).urls.length, 2);
  // Constrained-decoding providers (Mistral-hosted GLM) match patterns against
  // the whole string; a prefix-only pattern let them emit nothing but "https://".
  for (const pattern of [fetch.parameters.properties.url.pattern, fetch.parameters.properties.urls.items.pattern]) {
    const whole = new RegExp(`^(?:${pattern})$`);
    assert.ok(whole.test("https://www.rfc-editor.org/rfc/rfc9110.html"), pattern);
    assert.equal(whole.test("https://"), false, pattern);
  }
  for (const url of ["https://", "https://example.com/a b"]) {
    assert.throws(() => validate("fetch_content", { url }), /Validation failed/, url);
  }
  for (const args of [{ url: "https://example.com", auth: true }, { url: "https://example.com", auth: "profile" },
    { url: "https://example.com", proxy: "http://127.0.0.1:8080" }, { url: "https://example.com", proxy: "" },
    { url: "/etc/passwd" }, { url: "file:///etc/passwd" }, { url: "./video.mp4" }, { urls: ["https://example.com", "ftp://example.com/x"] }]) {
    assert.throws(() => validate("fetch_content", args), /Validation failed/, JSON.stringify(args));
  }
  for (const [name, args] of [["web_search", { query: "pi" }], ["source_check", { claim: "pi" }]]) {
    assert.equal("proxy" in tools.get(name).parameters.properties, false, name);
    assert.deepEqual(validate(name, args), args);
    assert.throws(() => validate(name, { ...args, proxy: "socks5h://10.0.0.1:1080" }), /Validation failed/, name);
  }
  assert.equal(tools.get("get_search_content").parameters.additionalProperties, undefined, "get_search_content is left as registered");
});

test("the researcher wrapper keeps the boundary even past schema validation", async () => {
  const executed = [];
  const schema = { type: "object", properties: { url: { type: "string" }, urls: { type: "array", items: { type: "string" } }, auth: {}, proxy: {} } };
  const factory = (pi) => {
    for (const name of [...webToolNames, "web_enable"]) {
      pi.registerTool({ name, parameters: name === "fetch_content" ? schema : { type: "object", properties: {} },
        execute: async (_id, params) => { executed.push(params); return { content: [] }; } });
    }
    console.warn("[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.");
    pi.sendMessage({ customType: "web-search-content-ready", content: "ready" }, { triggerTurn: true });
  };
  const { api, tools, messages } = recordingApi();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try { await childWebExtension(factory)(api); } finally { console.warn = warn; }
  assert.deepEqual(warnings, [], "the per-child activation warning is suppressed");
  assert.deepEqual(messages.map((m) => m.options), [{ triggerTurn: false }], "background notices never start a turn");
  const fetch = tools.get("fetch_content");
  for (const params of [{ url: "https://example.com", auth: false }, { url: "https://example.com", proxy: "http://127.0.0.1:1" },
    { url: "~/.ssh/id_ed25519" }, { urls: ["javascript:alert(1)"] }]) {
    const result = await fetch.execute("t", params);
    assert.match(result.details.error, /auth|proxy|http\(s\)/);
  }
  assert.match((await tools.get("web_search").execute("t", { query: "q", proxy: "http://10.0.0.1:3128" })).details.error, /proxy/);
  assert.deepEqual(executed, []);
  await fetch.execute("t", { url: "https://example.com" });
  await tools.get("web_search").execute("t", { query: "q" });
  assert.equal(executed.length, 2);
  assert.equal(researcherWebProblem("fetch_content", { urls: ["https://a.example", "https://b.example"] }), undefined);
  assert.equal(researcherWebProblem("get_search_content", { proxy: "x" }), undefined);
});

test("renamed, disabled or unexpected web tools fail researcher assembly", async () => {
  const parameters = { type: "object", properties: { url: { type: "string" }, urls: { type: "array", items: { type: "string" } } } };
  const only = (names) => (pi) => { for (const name of names) pi.registerTool({ name, parameters, execute: async () => ({}) }); };
  await assert.rejects(childWebExtension(only(webToolNames.filter((name) => name !== "source_check")))(recordingApi().api),
    /web tools unavailable: source_check/);
  await assert.rejects(childWebExtension(only(["websearch"]))(recordingApi().api), /Unexpected researcher web tool: websearch/);
});

test("overlapping researcher assemblies restore console.warn in any finishing order", async () => {
  const original = console.warn;
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const slow = (gate) => async (pi) => {
    await gate.promise;
    for (const name of webToolNames) pi.registerTool({ name, parameters: { type: "object", properties: { url: { type: "string" }, urls: { type: "array", items: { type: "string" } } } }, execute: async () => ({}) });
  };
  const first = childWebExtension(slow(gates[0]))(recordingApi().api);
  const second = childWebExtension(slow(gates[1]))(recordingApi().api);
  assert.notEqual(console.warn, original, "the filter is installed while assembling");
  gates[0].resolve(); await first;
  assert.notEqual(console.warn, original, "still filtered while the second assembles");
  gates[1].resolve(); await second;
  assert.equal(console.warn, original, "restored once none is assembling");
});
