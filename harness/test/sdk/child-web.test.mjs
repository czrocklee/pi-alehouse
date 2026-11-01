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
// Synthetic factories must explicitly model the pinned capability metadata;
// absent or changed descriptions are unsupported, not a compatibility fallback.
const fetchDescription = "Fetch URL(s). Available modes: raw. " +
  "Direct image URLs return resized image content when supported by the selected mode. " +
  "Supports YouTube transcripts, GitHub repositories, PDFs, and local videos when supported by the selected mode. " +
  "Full original content is stored for retrieval by responseId.";

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

test("adapted web metadata stays concise without changing upstream capabilities or dynamic guidance", async () => {
  const config = join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
  mkdirSync(dirname(config), { recursive: true });
  try {
    for (const settings of [{}, { fetch: { allowedModes: ["raw"], defaultMode: "raw" } },
      { webSearch: { allowedProviders: ["brave", "duckduckgo"] } },
      { tools: { getSearchContent: { enabled: false } } }]) {
      writeFileSync(config, JSON.stringify(settings));
      const { factory } = await new ChildWebModules(entry, load).acquire();
      const original = new Map(), snapshots = [];
      const { api, tools } = recordingApi();
      // Observe the actual pinned factory's incoming objects, not synthetic
      // stand-ins. Registration only: never execute a real web tool.
      const observed = (pi) => factory({ ...pi, registerTool(tool) {
        original.set(tool.name, tool);
        const properties = tool.parameters.properties;
        for (const node of [tool, tool.parameters, properties, ...Object.values(properties), properties.urls?.items].filter(Boolean)) {
          snapshots.push([node, Object.getOwnPropertyDescriptors(node)]);
        }
        pi.registerTool(tool);
      } });
      const assembly = childWebExtension(observed)(api);
      if (settings.tools) await assert.rejects(assembly, /web tools unavailable: get_search_content/);
      else await assembly;
      // Parameter names, constraints and configuration-driven enums stay intact;
      // only existing auth/proxy/HTTP boundaries and copied descriptions differ.
      const withoutDescriptions = (_key, value) => _key === "description" ? undefined : value;
      for (const name of ["web_search", "source_check", "fetch_content"]) {
        const raw = original.get(name), adapted = tools.get(name);
        const removed = name === "fetch_content" ? ["auth", "proxy"] : ["proxy"];
        assert.deepEqual(Object.keys(adapted.parameters.properties), Object.keys(raw.parameters.properties).filter((key) => !removed.includes(key)), name);
        assert(adapted.description.length < raw.description.length, `${name}: shorter tool description`);
        for (const [key, schema] of Object.entries(adapted.parameters.properties)) {
          const expected = JSON.parse(JSON.stringify(raw.parameters.properties[key], withoutDescriptions));
          if (name === "fetch_content" && key === "url") expected.pattern = schema.pattern;
          if (name === "fetch_content" && key === "urls") expected.items.pattern = schema.items.pattern;
          assert.deepEqual(JSON.parse(JSON.stringify(schema, withoutDescriptions)), expected, `${name}.${key}: same capability`);
        }
      }
      const search = tools.get("web_search"), rawSearch = original.get("web_search");
      assert(search.promptSnippet.length < rawSearch.promptSnippet.length);
      assert.match(search.description, /responseId/);
      assert.match(search.description, /background/);
      const providerHeader = rawSearch.description.slice(0, rawSearch.description.indexOf(". The default workflow"));
      assert(search.description.startsWith(providerHeader), "configured providers and all policy stay verbatim");
      for (const key of ["query", "queries", "workflow", "provider"]) {
        const schema = search.parameters.properties[key], raw = rawSearch.parameters.properties[key];
        assert.notEqual(schema, raw, key);
        assert(schema.description.length < raw.description.length, `${key}: shorter parameter description`);
        for (const metadata of ["~kind", "~optional", ...Object.getOwnPropertySymbols(raw)]) {
          assert.deepEqual(Object.getOwnPropertyDescriptor(schema, metadata), Object.getOwnPropertyDescriptor(raw, metadata), key);
        }
      }
      assert.match(search.parameters.properties.workflow.description, /none \(default\).*summary-review.*auto-summary/);
      assert.match(search.parameters.properties.provider.description, /default: configured provider, or auto if none/);
      for (const name of ["web_search", "source_check"]) {
        const policy = original.get(name).parameters.properties.provider.description.split("; ")[1];
        assert(tools.get(name).parameters.properties.provider.description.includes(policy), `${name}: configured all policy survives`);
      }
      assert.equal(tools.get("get_search_content"), original.get("get_search_content"), "retrieval metadata and responseId guidance stay upstream");
      const upstream = original.get("fetch_content"), fetch = tools.get("fetch_content");
      assert.notEqual(fetch, upstream);
      assert.match(upstream.description, /local videos/);
      assert.match(fetch.description, /^Fetch absolute HTTP\(S\) URL\(s\)\./);
      assert.doesNotMatch(fetch.description, /local video/i);
      assert.match(fetch.description, /YouTube transcripts, GitHub repositories, and PDFs/);
      const modeText = upstream.description.slice(upstream.description.indexOf("Available modes:"), upstream.description.indexOf(". Direct image"));
      const storageText = upstream.description.slice(upstream.description.indexOf("Full original content"));
      assert.ok(fetch.description.includes(modeText), "configuration-dependent modes remain verbatim");
      assert.ok(fetch.description.endsWith(storageText), "configuration-dependent storage note remains verbatim");
      assert.deepEqual(fetch.parameters.properties.mode, upstream.parameters.properties.mode);
      assert.equal(fetch.promptSnippet, upstream.promptSnippet);
      assert.equal(fetch.parameters["~kind"], "Object", "real pinned TypeBox metadata survives root copying");
      assert.equal(Object.getOwnPropertyDescriptor(fetch.parameters, "~kind").enumerable, false);
      for (const [key, kind] of [["url", "String"], ["urls", "Array"], ["timestamp", "String"], ["frames", "Integer"]]) {
        const adapted = fetch.parameters.properties[key], raw = upstream.parameters.properties[key];
        assert.notEqual(adapted, raw, key);
        assert.equal(adapted["~kind"], kind, key);
        assert.equal(adapted["~optional"], true, key);
        for (const metadata of ["~kind", "~optional", ...Object.getOwnPropertySymbols(raw)]) {
          assert.deepEqual(Object.getOwnPropertyDescriptor(adapted, metadata), Object.getOwnPropertyDescriptor(raw, metadata), key);
        }
        assert.doesNotMatch(adapted.description, /local video/i, key);
      }
      assert.equal(fetch.parameters.properties.urls.items["~kind"], "String");
      for (const key of ["url", "urls"]) assert.match(fetch.parameters.properties[key].description, /absolute HTTP\(S\)/);
      for (const key of ["timestamp", "frames"]) assert.match(fetch.parameters.properties[key].description, /YouTube/);
      assert.equal(fetch.parameters.properties.frames.minimum, 1);
      assert.equal(fetch.parameters.properties.frames.maximum, 12);
      const youtube = { url: "https://www.youtube.com/watch?v=example", timestamp: "23:41-25:00", frames: 6 };
      assert.deepEqual(validateToolArguments(fetch, { type: "toolCall", id: "metadata", name: "fetch_content", arguments: youtube }), youtube);
      for (const [node, descriptors] of snapshots) assert.deepEqual(Object.getOwnPropertyDescriptors(node), descriptors, "factory objects are untouched");
    }
  } finally { rmSync(config, { force: true }); }
});

test("missing or drifted fetch capability metadata rejects assembly before tool registration or execution", async () => {
  const parameters = { type: "object", properties: {
    url: { type: "string" }, urls: { type: "array", items: { type: "string" } },
  } };
  for (const description of [undefined, "", fetchDescription.replace("local videos", "local video files"),
    fetchDescription.replace("Fetch URL(s).", "Fetch content."),
    fetchDescription.replace("Direct image URLs return resized image content when supported by the selected mode.", "Images supported."),
    `${fetchDescription} Local videos are also supported.`, `${fetchDescription} ${fetchDescription}`]) {
    const { api, tools } = recordingApi();
    let executions = 0;
    const factory = (pi) => pi.registerTool({ name: "fetch_content", description, parameters,
      execute: async () => { executions++; return { content: [] }; } });
    const before = Object.getOwnPropertyDescriptors(parameters);
    const warn = console.warn;
    await assert.rejects(childWebExtension(factory)(api), /Unsupported pi-web-access fetch_content metadata:/);
    assert.equal(tools.has("fetch_content"), false, "unsupported fetch metadata is never exposed");
    assert.equal(executions, 0, "registration only; no live web executor");
    assert.equal(console.warn, warn, "failed assembly restores warning suppression");
    assert.deepEqual(Object.getOwnPropertyDescriptors(parameters), before, "rejection does not mutate upstream schema");
  }
});

test("the researcher wrapper keeps the boundary even past schema validation", async () => {
  const executed = [];
  const kind = Symbol("kind"), optional = Symbol("optional");
  const schema = { [kind]: "Object", type: "object", properties: {
    url: { [kind]: "String", [optional]: true, type: "string" },
    urls: { [kind]: "Array", [optional]: true, type: "array", items: { [kind]: "String", type: "string" } },
    timestamp: { [kind]: "String", [optional]: true, type: "string" },
    frames: { [kind]: "Integer", [optional]: true, type: "integer" }, auth: {}, proxy: {},
  } };
  const originalDescriptors = Object.getOwnPropertyDescriptors(schema);
  const factory = (pi) => {
    for (const name of [...webToolNames, "web_enable"]) {
      pi.registerTool({ name, description: name === "fetch_content" ? fetchDescription : undefined,
        parameters: name === "fetch_content" ? schema : { type: "object", properties: {} },
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
  assert.equal(fetch.parameters[kind], "Object");
  for (const key of ["url", "urls", "timestamp", "frames"]) {
    assert.equal(fetch.parameters.properties[key][kind], schema.properties[key][kind], key);
    assert.equal(fetch.parameters.properties[key][optional], true, key);
  }
  assert.equal(fetch.parameters.properties.urls.items[kind], "String");
  assert.deepEqual(Object.getOwnPropertyDescriptors(schema), originalDescriptors);
  for (const params of [{ url: "https://example.com", auth: false }, { url: "https://example.com", proxy: "http://127.0.0.1:1" },
    { url: "~/.ssh/id_ed25519" }, { urls: ["javascript:alert(1)"] }]) {
    const result = await fetch.execute("t", params);
    assert.match(result.details.error, /auth|proxy|http\(s\)/);
  }
  assert.match((await tools.get("web_search").execute("t", { query: "q", proxy: "http://10.0.0.1:3128" })).details.error, /proxy/);
  assert.deepEqual(executed, []);
  await fetch.execute("t", { url: "https://example.com" });
  const youtube = { url: "https://www.youtube.com/watch?v=example", timestamp: "23:41-25:00", frames: 6 };
  await fetch.execute("t", youtube);
  await tools.get("web_search").execute("t", { query: "q" });
  assert.equal(executed.length, 3);
  assert.equal(executed[1], youtube, "YouTube options reach only the synthetic executor unchanged; no network");
  assert.equal(researcherWebProblem("fetch_content", { urls: ["https://a.example", "https://b.example"] }), undefined);
  assert.equal(researcherWebProblem("get_search_content", { proxy: "x" }), undefined);
});

test("renamed, disabled or unexpected web tools fail researcher assembly", async () => {
  const parameters = { type: "object", properties: { url: { type: "string" }, urls: { type: "array", items: { type: "string" } } } };
  const only = (names) => (pi) => { for (const name of names) pi.registerTool({ name,
    description: name === "fetch_content" ? fetchDescription : undefined, parameters, execute: async () => ({}) }); };
  await assert.rejects(childWebExtension(only(webToolNames.filter((name) => name !== "source_check")))(recordingApi().api),
    /web tools unavailable: source_check/);
  await assert.rejects(childWebExtension(only(["websearch"]))(recordingApi().api), /Unexpected researcher web tool: websearch/);
});

test("overlapping researcher assemblies restore console.warn in any finishing order", async () => {
  const original = console.warn;
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const slow = (gate) => async (pi) => {
    await gate.promise;
    for (const name of webToolNames) pi.registerTool({ name, description: name === "fetch_content" ? fetchDescription : undefined,
      parameters: { type: "object", properties: { url: { type: "string" }, urls: { type: "array", items: { type: "string" } } } }, execute: async () => ({}) });
  };
  const first = childWebExtension(slow(gates[0]))(recordingApi().api);
  const second = childWebExtension(slow(gates[1]))(recordingApi().api);
  assert.notEqual(console.warn, original, "the filter is installed while assembling");
  gates[0].resolve(); await first;
  assert.notEqual(console.warn, original, "still filtered while the second assembles");
  gates[1].resolve(); await second;
  assert.equal(console.warn, original, "restored once none is assembling");
});
