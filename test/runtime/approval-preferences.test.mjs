import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import { registerSettingsStore, settingsStoreForSession, SettingsStore } from "../../lib/settings-store.mjs";

// Only controlled bus/context/UI doubles: no provider, network, human dialog,
// user config write or generated runtime is needed by these source regressions.
const jiti = createJiti(import.meta.url);
const { default: approvalMode, APPROVAL_ENTRY } = await jiti.import("../../extensions/approval-mode.ts");
const { sessionYoloSet } = await jiti.import("../../extensions/lib/approval-protocol.ts");
const MANUAL = { mode: "shadow", includeSubagents: false };
const ROOT = { mode: "enforce", includeSubagents: false };
const SUB = { mode: "enforce", includeSubagents: true };
const theme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const deferred = () => {
  let resolve;
  const promise = new Promise((answer) => { resolve = answer; });
  return { promise, resolve };
};
const record = (sessionId, yolo, judge) => ({ type: "custom", customType: APPROVAL_ENTRY,
  data: { sessionId, yolo, ...(judge ? { judge } : {}) } });

function fakeStore({ scope = "session", approval, trusted = true, stageError, effectiveError } = {}) {
  const stages = [];
  return {
    scope, workspaceTrusted: trusted, stages,
    paths: { global: "/fixture/agent/alehouse-settings.json", workspace: "/fixture/project/.pi/alehouse-settings.json" },
    canWriteWorkspace() { return this.workspaceTrusted; },
    effective() { if (effectiveError) throw effectiveError; return { approval }; },
    get: () => ({ approval }),
    stage(target, path, value) { if (stageError) throw stageError; stages.push({ scope: target, path, value }); },
    pending: () => [...stages],
    flush() { throw new Error("approval must never flush settings"); },
    seal() { throw new Error("approval must never seal settings"); },
  };
}

let sequence = 0;
function fixture(t, options = {}) {
  const handlers = new Map(), listeners = new Map(), commands = new Map();
  const notices = [], dialogs = [], selects = [], requests = [], entries = [], statuses = new Map();
  const cleanupRegistry = [];
  let ctx, branch = [], judge;
  const host = { mode: "fullscreen", terminal: { rows: 40 }, mounts: 0, requestRender() {},
    showOverlay(component) {
      host.mounts++;
      host.component = component;
      return { hide() { host.component = undefined; } };
    } };
  const events = {
    on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); },
    emit(name, data) { for (const handler of listeners.get(name) ?? []) handler(data); },
  };
  const pi = {
    events,
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) {
      if (options.appendError) throw options.appendError;
      entries.push({ type: "custom", customType, data });
    },
  };
  approvalMode(pi);
  const publish = (mode = judge, id = ctx.sessionManager.getSessionId()) => {
    judge = { judge: "jev", ...mode };
    events.emit("approval:judge-state", { ...judge, sessionId: id, shown: false });
  };
  events.on("approval:set-judge", (request) => {
    requests.push({ mode: request.mode, includeSubagents: request.includeSubagents });
    if (options.rejectJudge) return;
    request.applied = true;
    publish(options.appliedMode ?? request);
  });
  const start = ({ id = `approval-preference-${++sequence}`, saved = [], store = options.store, settle = true,
    judges = options.judges !== false, judgeFirst = options.judgeFirst === true } = {}) => {
    branch = saved;
    entries.length = 0;
    judge = { judge: "jev", ...(options.launch ?? SUB) };
    if (store) cleanupRegistry.push(registerSettingsStore(id, store));
    ctx = {
      mode: options.fullscreen ? "tui" : "rpc", hasUI: options.hasUI !== false, cwd: "/fixture/project",
      sessionManager: {
        getSessionId: () => id,
        getBranch: () => { if (options.branchError) throw options.branchError; return [...branch, ...entries]; },
      },
      ui: {
        theme,
        setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
        setWidget: (_key, factory) => factory?.(host, theme),
        notify(message, level) { if (options.notifyError) throw options.notifyError; notices.push({ message, level }); },
        confirm: async (title, text) => {
          dialogs.push({ title, text, popoverVisible: !!host.component });
          return typeof options.confirm === "function" ? options.confirm(title, text) : options.confirm ?? true;
        },
        select: async (title, choices) => {
          selects.push({ title, choices });
          return options.select?.(title, choices);
        },
      },
    };
    if (judges && judgeFirst) publish();
    const started = handlers.get("session_start")({}, ctx);
    if (options.dispatchYield) {
      // Like SDK dispatch/mountApproval: awaiting session_start drains queued
      // restore microtasks before a judge loaded second publishes its launch.
      return (async () => {
        await started;
        if (judges && !judgeFirst) publish();
        if (settle) await tick();
      })();
    }
    if (judges && !judgeFirst) publish();
    return settle ? tick() : Promise.resolve();
  };
  const run = (args, context = ctx) => commands.get("approval").handler(args, context);
  const shutdown = () => handlers.get("session_shutdown")({}, ctx);
  t.after(() => { if (ctx) shutdown(); for (const cleanup of cleanupRegistry.reverse()) cleanup(); });
  return { start, run, publish, shutdown, notices, dialogs, selects, requests, entries, statuses, host, events,
    tree(saved) { branch = saved; entries.length = 0; handlers.get("session_tree")({}, ctx); },
    get ctx() { return ctx; }, get id() { return ctx.sessionManager.getSessionId(); },
    get choice() { return statuses.get("approval"); },
    get description() { return commands.get("approval").description; } };
}

for (const scope of ["global", "workspace"]) {
  test(`user choices stage actual approval at shared ${scope} scope, not observer/audit paths`, async (t) => {
    const store = fakeStore({ scope });
    const f = fixture(t, { store });
    await f.start();
    assert.equal(settingsStoreForSession(f.id), store, "uses the shared registry, not a private store");
    assert.deepEqual(store.stages, []);
    await f.run("manual");
    await f.run("judge");
    await f.run("judge+sub");
    await f.run("yolo");
    assert.deepEqual(store.stages.map((change) => change.value), ["manual", "judge", "judge+sub", "yolo"]);
    assert(store.stages.every((change) => change.scope === scope && JSON.stringify(change.path) === '["approval"]'));
    const staged = store.stages.length;
    f.publish(MANUAL);
    f.tree([record(f.id, true, SUB)]);
    f.shutdown();
    assert.equal(store.stages.length, staged, "judge events, /tree and teardown never stage");
    assert(f.notices.some(({ message }) => /normal exit/.test(message)));
  });
}

test("session scope and ordinary Pi without a registered store never stage", async (t) => {
  const store = fakeStore();
  const f = fixture(t, { store });
  await f.start();
  await f.run("manual");
  await f.run("yolo");
  assert.deepEqual(store.stages, []);
  const ordinary = fixture(t);
  await ordinary.start();
  assert.equal(settingsStoreForSession(ordinary.id), undefined);
  await ordinary.run("yolo");
  await ordinary.run("manual");
  await ordinary.run("save global");
  assert(ordinary.notices.some(({ message }) => /only in an Alehouse session/.test(message)));
});

test("a rejected widening confirmation does not stage or record", async (t) => {
  const store = fakeStore({ scope: "global" });
  const f = fixture(t, { store, launch: MANUAL, confirm: false });
  await f.start();
  await f.run("judge");
  await f.run("yolo");
  assert.deepEqual(store.stages, []);
  assert.deepEqual(f.entries, []);
  assert.equal(sessionYoloSet().has(f.id), false);
});

test("staging failures and audit/UI failures cannot revoke or prevent a live choice", async (t) => {
  const store = fakeStore({ scope: "global", stageError: new Error("save-stage-failed") });
  const f = fixture(t, { store, appendError: new Error("audit-failed") });
  await f.start();
  await f.run("yolo");
  assert.equal(sessionYoloSet().has(f.id), true);
  assert(f.notices.some(({ message }) => /could not be staged.*save-stage-failed/.test(message)));
  assert(f.notices.some(({ message }) => /could not be recorded.*audit-failed/.test(message)));
  await f.run("manual");
  assert.equal(sessionYoloSet().has(f.id), false);
  assert.equal(f.choice, "approval: manual");
  const good = fakeStore({ scope: "workspace" });
  const brokenUi = fixture(t, { store: good, notifyError: new Error("UI gone") });
  await brokenUi.start();
  await brokenUi.run("yolo");
  assert.equal(sessionYoloSet().has(brokenUi.id), true);
  assert.equal(good.stages.at(-1).value, "yolo");
});

test("a controller rejection stages the current actual mode, never the requested one", async (t) => {
  const store = fakeStore({ scope: "global" });
  const f = fixture(t, { store, rejectJudge: true });
  await f.start();
  await f.run("manual");
  assert.equal(f.choice, "approval: jev+sub");
  assert.equal(store.stages.at(-1).value, "judge+sub");
});

test("popover user choices use the same staged path after deliberate double choice", async (t) => {
  const store = fakeStore({ scope: "workspace" });
  const f = fixture(t, { store, fullscreen: true });
  await f.start();
  f.events.emit("pi-footer:indicator-click", { key: "approval" });
  f.host.component.handleInput("\u001b[F");
  f.host.component.handleInput("\r");
  assert.deepEqual(store.stages, [], "first activation only arms yolo");
  f.host.component.handleInput("\r");
  assert.equal(sessionYoloSet().has(f.id), true);
  assert.equal(store.stages.at(-1).value, "yolo");
});

for (const judgeFirst of [true, false]) {
  test(`same-session branch records precede preferences and retain launch cap (judgeFirst=${judgeFirst})`, async (t) => {
    const store = fakeStore({ scope: "global", approval: "yolo" });
    const f = fixture(t, { store, judgeFirst });
    await f.start({ id: `branch-${judgeFirst}`, saved: [record(`branch-${judgeFirst}`, false, MANUAL)] });
    assert.equal(f.choice, "approval: manual");
    assert.equal(f.dialogs.length, 0);
    assert.deepEqual(store.stages, []);
    const capped = fixture(t, { store, judgeFirst, launch: ROOT });
    await capped.start({ id: `cap-${judgeFirst}`, saved: [record(`cap-${judgeFirst}`, false, SUB)] });
    assert.equal(capped.choice, "approval: jev");
    assert.equal(capped.dialogs.length, 0, "old branch records cannot prompt to exceed launch");
    assert.deepEqual(capped.requests, []);
  });
}

for (const judgeFirst of [true, false]) for (const origin of ["branch", "preference"]) {
  test(`manual ${origin} is restored before startup returns and tree cannot preserve launch authority (judgeFirst=${judgeFirst})`, async (t) => {
    const id = `immediate-manual-${origin}-${judgeFirst}`;
    const store = fakeStore({ scope: "global", approval: origin === "preference" ? "manual" : "judge+sub" });
    const f = fixture(t, { store, judgeFirst, dispatchYield: true });
    await f.start({ id, settle: false, saved: origin === "branch" ? [record(id, false, MANUAL)] : [] });
    assert.equal(f.choice, "approval: manual", "narrowing cannot wait for a timer after session startup");
    f.tree([]);
    await tick();
    assert.equal(f.choice, "approval: manual");
    assert.deepEqual(f.entries.at(-1).data.judge, MANUAL, "tree records only the already narrowed live mode");
    assert.deepEqual(store.stages, [], "restoration/navigation never stage preferences");
  });
}

for (const judgeFirst of [true, false]) for (const [launch, choice] of [[MANUAL, "manual"], [ROOT, "judge"], [SUB, "judge+sub"]]) {
  test(`explicit launch-equivalent ${choice} has session evidence before changed defaults on resume (judgeFirst=${judgeFirst})`, async (t) => {
    const f = fixture(t, { launch, judgeFirst });
    await f.start();
    assert.deepEqual(f.entries, [], "unchosen startup still creates no evidence");
    await f.run(choice);
    assert.equal(f.entries.length, 1);
    assert.deepEqual(f.entries[0].data.judge, launch);
    await f.run(choice);
    f.publish(launch);
    assert.equal(f.entries.length, 1, "matching evidence is not duplicated by choices or observers");
    const saved = structuredClone(f.entries), id = f.id;
    const store = fakeStore({ approval: choice === "manual" ? "judge+sub" : "manual" });
    await f.start({ id, saved, store });
    assert.equal(f.choice, choice === "manual" ? "approval: manual" : choice === "judge" ? "approval: jev" : "approval: jev+sub");
    assert.deepEqual(f.dialogs, [], "changed preferences cannot override or widen an explicit session choice");
    assert.deepEqual(store.stages, []);
  });
}

test("provisional cached narrowing does not cap a later fresh same-ID launch", async (t) => {
  const f = fixture(t, { dispatchYield: true });
  await f.start({ id: "provisional-launch-cap" });
  await f.run("manual");
  await f.start({ id: f.id, saved: [record(f.id, false, ROOT)], settle: false });
  assert.equal(f.choice, "approval: jev", "fresh judge-second enforce restores root, not stale cached shadow");
  await tick();
  assert.equal(f.choice, "approval: jev");
  assert.deepEqual(f.dialogs, []);
});

test("provisional cached enforce clamp cannot widen a fresh shadow launch after awaited dispatch", async (t) => {
  const store = fakeStore({ scope: "global", approval: "judge+sub" });
  const options = { store, launch: SUB, dispatchYield: true };
  const f = fixture(t, options);
  await f.start({ id: "provisional-fresh-shadow" });
  const before = f.requests.length;
  options.launch = MANUAL;
  const starting = f.start({ id: f.id, saved: [record(f.id, false, ROOT)], settle: false });
  assert.equal(f.choice, "approval: manual", "cached SUB is provisionally clamped before the fresh publication");
  assert.deepEqual(f.requests.slice(before), [MANUAL]);
  assert.deepEqual(f.entries, [], "the provisional clamp is not branch evidence");
  await starting; await tick();
  assert.equal(f.choice, "approval: manual", "the fresh shadow cap wins over the recorded root mode");
  assert(f.requests.slice(before).every((request) => request.mode === "shadow"), "startup must never request enforce under the new cap");
  assert.deepEqual(store.stages, []);
  assert.deepEqual(f.dialogs, []);
});

test("a same-session record without a judge still blocks preference fallback", async (t) => {
  const store = fakeStore({ approval: "yolo" });
  const f = fixture(t, { store });
  await f.start({ id: "no-judge-record", saved: [record("no-judge-record", false)] });
  assert.equal(f.dialogs.length, 0);
  assert.equal(sessionYoloSet().has(f.id), false);
});

test("foreign and malformed records are inapplicable; preferences may narrow directly", async (t) => {
  const store = fakeStore({ scope: "global", approval: "manual" });
  const f = fixture(t, { store });
  await f.start({ saved: [record("foreign", true, SUB)] });
  assert.equal(f.choice, "approval: manual");
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(store.stages, []);
  await f.start({ id: "malformed", saved: [record("malformed", "yes", SUB)] });
  assert.equal(f.choice, "approval: manual");
});

for (const preference of ["manual", "judge", "judge+sub"]) {
  test(`saved ${preference} at or below launch restores after judge binding without staging`, async (t) => {
    const store = fakeStore({ scope: "workspace", approval: preference });
    const f = fixture(t, { store });
    await f.start();
    assert.equal(f.choice, `approval: ${preference === "manual" ? "manual" : preference === "judge" ? "jev" : "jev+sub"}`);
    assert.equal(f.dialogs.length, 0);
    assert.deepEqual(store.stages, []);
  });
}

for (const preference of ["judge", "judge+sub"]) for (const accepted of [true, false]) {
  test(`saved ${preference} above launch requires deliberate confirmation (${accepted})`, async (t) => {
    const store = fakeStore({ scope: "global", approval: preference });
    const f = fixture(t, { store, launch: MANUAL, confirm: accepted });
    await f.start();
    assert.equal(f.dialogs.length, 1);
    assert.match(f.dialogs[0].title, /Let jev approve/);
    assert.equal(f.choice, accepted ? `approval: ${preference === "judge" ? "jev" : "jev+sub"}` : "approval: manual");
    assert.deepEqual(store.stages, []);
    f.publish(); f.publish();
    await tick();
    assert.equal(f.dialogs.length, 1, "repeated publications cannot repeat a prompt");
  });
}

test("a wider preference never grants headlessly or on thrown confirmation", async (t) => {
  for (const settings of [{ hasUI: false }, { confirm: () => { throw new Error("no dialog"); } }]) {
    const store = fakeStore({ approval: "judge+sub" });
    const f = fixture(t, { store, launch: MANUAL, ...settings });
    await f.start();
    assert.equal(f.choice, settings.hasUI === false ? undefined : "approval: manual");
    assert.deepEqual(f.requests, []);
    assert.equal(sessionYoloSet().has(f.id), false);
    assert.deepEqual(store.stages, []);
  }
});

test("missing judge warns once, never maps preference to yolo or later resurrects its dialog", async (t) => {
  const store = fakeStore({ approval: "judge+sub" });
  const f = fixture(t, { store, judges: false, launch: MANUAL });
  await f.start();
  assert.equal(f.choice, "approval: manual");
  assert.equal(sessionYoloSet().has(f.id), false);
  assert(f.notices.some(({ message }) => /no judge is available/.test(message)));
  f.publish(MANUAL); f.publish(MANUAL);
  await tick();
  assert.equal(f.dialogs.length, 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(store.stages, []);
});

for (const origin of ["branch", "preference"]) {
  test(`${origin} yolo always needs new session confirmation; rejection and restore never stage`, async (t) => {
    const store = fakeStore({ scope: "global", approval: "yolo" });
    const answer = deferred();
    const f = fixture(t, { store, confirm: () => answer.promise });
    await f.start({ id: `yolo-${origin}`, saved: origin === "branch" ? [record(`yolo-${origin}`, true, ROOT)] : [] });
    assert.equal(f.dialogs.length, 1);
    assert.equal(sessionYoloSet().has(f.id), false, "saved preference/record is not live authority");
    assert.match(f.dialogs[0].text, /explicit denies.*fail-closed floor/s);
    answer.resolve(true);
    await tick();
    assert.equal(sessionYoloSet().has(f.id), true);
    assert.deepEqual(store.stages, []);
    f.shutdown();
    assert.equal(sessionYoloSet().has(f.id), false);
    await f.start({ id: `yolo-new-${origin}` });
    assert.equal(f.dialogs.length, 2, "new session asks anew, even with the same store");
  });
}

test("yolo preference needs UI and literal true, and rejection never stages", async (t) => {
  for (const setting of [{ hasUI: false }, { confirm: false }, { confirm: () => undefined },
    { confirm: () => "yes" }, { confirm: () => { throw new Error("UI failed"); } }]) {
    const store = fakeStore({ scope: "workspace", approval: "yolo" });
    const f = fixture(t, { store, ...setting });
    await f.start();
    assert.equal(sessionYoloSet().has(f.id), false);
    assert.deepEqual(store.stages, []);
  }
});

test("late startup judge or yolo confirmations cannot undo a newer manual user choice", async (t) => {
  for (const approval of ["judge+sub", "yolo"]) {
    const store = fakeStore({ scope: "global", approval });
    const answer = deferred();
    const f = fixture(t, { store, launch: MANUAL, confirm: () => answer.promise });
    await f.start();
    await f.run("manual");
    answer.resolve(true);
    await tick();
    assert.equal(f.choice, "approval: manual");
    assert.equal(sessionYoloSet().has(f.id), false);
    assert.deepEqual(store.stages.map(({ value }) => value), ["manual"]);
  }
});

test("a deferred same-session branch restore cannot undo a newer user choice", async (t) => {
  const store = fakeStore({ scope: "global", approval: "manual" });
  const f = fixture(t, { store, fullscreen: true });
  const starting = f.start({ id: "late-branch", saved: [record("late-branch", false, MANUAL)], settle: false });
  // Startup queued restoreJudge, but this synchronous popover choice wins first.
  f.events.emit("pi-footer:indicator-click", { key: "approval" });
  f.host.component.handleInput("\u001b[F");
  f.host.component.handleInput("\r");
  f.host.component.handleInput("\r");
  await starting;
  await tick();
  assert.equal(f.choice, "approval: YOLO");
  assert.equal(store.stages.at(-1).value, "yolo");
});

for (const leave of ["switch", "shutdown", "tree"]) {
  test(`late startup confirmations grant nothing after ${leave}`, async (t) => {
    for (const approval of ["judge+sub", "yolo"]) {
      const store = fakeStore({ approval });
      const answer = deferred();
      const f = fixture(t, { store, launch: MANUAL, confirm: () => answer.promise });
      await f.start();
      const old = f.id;
      if (leave === "switch") await f.start({ store: fakeStore(), judges: true });
      else if (leave === "shutdown") f.shutdown();
      else f.tree([]);
      answer.resolve(true);
      await tick();
      assert.equal(sessionYoloSet().has(old), false);
      assert.equal(sessionYoloSet().has(f.id), false);
      assert.deepEqual(f.requests, []);
      assert.deepEqual(store.stages, []);
    }
  });
}

test("external judge changes retire a pending startup dialog without staging", async (t) => {
  const store = fakeStore({ approval: "judge+sub" });
  const answer = deferred();
  const f = fixture(t, { store, launch: MANUAL, confirm: () => answer.promise });
  await f.start();
  f.publish(ROOT);
  answer.resolve(true);
  await tick();
  assert.equal(f.choice, "approval: jev");
  assert.deepEqual(f.requests, []);
  assert.deepEqual(store.stages, []);
});

test("explicit save displays exact destination, actual choice and new-session promise; scope/live mode stay unchanged", async (t) => {
  const store = fakeStore();
  const f = fixture(t, { store });
  await f.start();
  await f.run("save global");
  assert.match(f.dialogs.at(-1).text, /approval: judge\+sub/);
  assert(f.dialogs.at(-1).text.includes(store.paths.global));
  assert.match(f.dialogs.at(-1).text, /on normal exit/);
  assert.match(f.dialogs.at(-1).text, /yolo always needs a new explicit confirmation in every session/);
  assert.deepEqual(store.stages, [{ scope: "global", path: ["approval"], value: "judge+sub" }]);
  assert.equal(store.scope, "session");
  assert.equal(f.choice, "approval: jev+sub");
  assert.deepEqual(f.requests, []);
  await f.run("yolo");
  await f.run("save workspace");
  assert(f.dialogs.at(-1).text.includes(store.paths.workspace));
  assert.match(f.dialogs.at(-1).text, /project config file visible to Git/);
  assert.match(f.dialogs.at(-1).text, /project-trust prompt in a future Pi session/);
  assert.match(f.dialogs.at(-1).text, /does not grant project trust/);
  assert.equal(store.stages.at(-1).value, "yolo");
  assert.equal(store.scope, "session");
});

test("save accepts scope selection, refuses invalid scope, unavailable UI and untrusted workspace", async (t) => {
  const store = fakeStore({ trusted: false });
  const f = fixture(t, { store, select: (_title, options) => options.find((label) => label === "All projects") });
  await f.start();
  await f.run("save");
  assert.equal(store.stages.length, 1);
  await f.run("save workspace");
  await f.run("save session");
  assert.equal(store.stages.length, 1);
  assert.equal(f.dialogs.length, 1, "no confirmation opens for untrusted/invalid destination");
  f.ctx.hasUI = false;
  await f.run("save global");
  assert.equal(store.stages.length, 1);
  assert(f.notices.some(({ message }) => /untrusted workspace/.test(message)));
});

test("save cancellation/failure is independent of live mode and never stages", async (t) => {
  for (const confirm of [false, () => { throw new Error("dialog unavailable"); }]) {
    const store = fakeStore();
    const f = fixture(t, { store, confirm });
    await f.start();
    await f.run("save global");
    assert.deepEqual(store.stages, []);
    assert.equal(f.choice, "approval: jev+sub");
  }
});

for (const leave of ["switch", "shutdown", "choice", "trust"]) {
  test(`save confirmation is stale after ${leave} and never stages an unseen choice`, async (t) => {
    const store = fakeStore();
    const answer = deferred();
    const f = fixture(t, { store, confirm: () => answer.promise });
    await f.start();
    const pending = f.run("save workspace");
    if (leave === "switch") await f.start({ store: fakeStore() });
    else if (leave === "shutdown") f.shutdown();
    else if (leave === "choice") await f.run("manual");
    else store.workspaceTrusted = false;
    answer.resolve(true);
    await pending;
    assert.deepEqual(store.stages, []);
  });
}

test("scope picker epoch is checked after await", async (t) => {
  const store = fakeStore(), answer = deferred();
  const f = fixture(t, { store, select: () => answer.promise });
  await f.start();
  const pending = f.run("save");
  await f.start({ store: fakeStore() });
  answer.resolve("All projects");
  await pending;
  assert.deepEqual(store.stages, []);
  assert.equal(f.dialogs.length, 0);
});

test("failed branch/effective reads never provide preference authority", async (t) => {
  for (const options of [{ branchError: new Error("branch unavailable"), store: fakeStore({ approval: "yolo" }) },
    { store: fakeStore({ effectiveError: new Error("store unavailable") }) }]) {
    const f = fixture(t, options);
    await f.start();
    assert.equal(f.dialogs.length, 0);
    assert.equal(sessionYoloSet().has(f.id), false);
    assert(f.notices.some(({ message }) => /could not be restored/.test(message)));
  }
});

test("real shared store staging leaves config unchanged and creates no workspace directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "alehouse-approval-preference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), cwd = join(root, "workspace");
  mkdirSync(agentDir); mkdirSync(cwd);
  const globalPath = join(agentDir, "extensions/pi-alehouse/config.json");
  mkdirSync(dirname(globalPath), { recursive: true });
  const original = '{"version":2,"approval":"judge"}\n';
  writeFileSync(globalPath, original);
  const store = new SettingsStore({ agentDir, cwd, projectTrusted: true });
  store.setScope("global");
  const f = fixture(t, { store });
  await f.start();
  assert.equal(f.choice, "approval: jev");
  assert.deepEqual(store.pending(), [], "startup restore does not stage");
  await f.run("yolo");
  await f.run("save workspace");
  assert.deepEqual(store.pending(), [
    { scope: "global", path: ["approval"], value: "yolo" },
    { scope: "workspace", path: ["approval"], value: "yolo" },
  ]);
  assert.equal(readFileSync(globalPath, "utf8"), original);
  assert.equal(existsSync(join(cwd, ".pi")), false, "even remembering creates no config resources now");
  assert(f.dialogs.at(-1).text.includes(store.paths.workspace));
  assert.equal(store.scope, "global", "explicit remembering must not change shared scope");
  f.shutdown();
  assert.equal(readFileSync(globalPath, "utf8"), original, "only the harness owns flushing");
  assert.equal(existsSync(join(cwd, ".pi")), false);
});

test("sealed shared store rejects persistence without blocking live narrowing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "alehouse-approval-sealed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SettingsStore({ agentDir: root, cwd: root, projectTrusted: false });
  store.setScope("global");
  const f = fixture(t, { store });
  await f.start();
  await f.run("yolo");
  store.seal();
  await f.run("manual");
  assert.equal(sessionYoloSet().has(f.id), false);
  assert.equal(f.choice, "approval: manual");
  assert(f.notices.some(({ message }) => /could not be staged.*sealed/.test(message)));
});

test("a same-ID fresh launch publication is not mistaken for a newer user choice", async (t) => {
  const store = fakeStore({ scope: "global" });
  const f = fixture(t, { store });
  await f.start({ id: "same-id-launch" });
  await f.run("manual");
  await f.start({ id: "same-id-launch", saved: [record("same-id-launch", true, ROOT)] });
  assert.equal(f.dialogs.length, 1, "valid same-session yolo still reaches confirmation");
  assert.equal(f.dialogs[0].title, "Resume yolo for this session?");
  assert.equal(f.choice, "approval: YOLO");
  assert.deepEqual(f.requests.at(-1), ROOT, "restoration uses the fresh launch cap, not cached manual");
  assert.deepEqual(store.stages.map(({ value }) => value), ["manual"], "startup never stages");
});

for (const confirm of [true, false]) {
  test(`a no-confirm pick newly widened by startup narrowing asks for consent (${confirm})`, async (t) => {
    const store = fakeStore({ scope: "global" });
    const f = fixture(t, { store, launch: ROOT, confirm });
    const starting = f.start({ id: `narrowing-race-${confirm}`,
      saved: [record(`narrowing-race-${confirm}`, false, MANUAL)], settle: false });
    const choosing = f.run("judge");
    await starting; await choosing; await tick();
    assert.equal(f.dialogs.length, 1, "initially equal choice became widening while awaiting");
    assert.match(f.dialogs[0].title, /Let jev approve/);
    assert.equal(f.choice, confirm ? "approval: jev" : "approval: manual");
    assert.deepEqual(store.stages.map(({ value }) => value), confirm ? ["judge"] : []);
  });
}

test("a newly widening pick cannot grant headlessly after startup narrowing", async (t) => {
  const store = fakeStore({ scope: "global" });
  const f = fixture(t, { store, launch: ROOT, hasUI: false });
  const starting = f.start({ id: "headless-narrowing-race", saved: [record("headless-narrowing-race", false, MANUAL)], settle: false });
  const choosing = f.run("judge");
  await starting; await choosing; await tick();
  assert.deepEqual(f.requests, [MANUAL]);
  assert.deepEqual(store.stages, []);
  assert.deepEqual(f.dialogs, []);
});

test("awaited same-ID startup offers stale yolo after failed audit without inheriting a grant", async (t) => {
  const answer = deferred(), store = fakeStore({ scope: "global" });
  const options = { store, dispatchYield: true,
    confirm: (title) => title === "Resume yolo for this session?" ? answer.promise : true };
  const f = fixture(t, options);
  await f.start({ id: "awaited-same-id-audit" });
  f.publish(MANUAL); // An external choice is recorded, never staged.
  await f.run("yolo");
  options.appendError = new Error("disk full");
  await f.run("manual");
  assert.equal(sessionYoloSet().has(f.id), false, "failed audit cannot prevent live revocation");
  assert.equal(f.entries.at(-1).data.yolo, true, "old branch still requests yolo");
  assert(f.notices.some(({ message }) => /could not be recorded.*disk full/.test(message)));
  const saved = [...f.entries], stages = store.stages.length;
  options.appendError = undefined;
  await f.start({ id: f.id, saved });
  assert.equal(f.dialogs.at(-1).title, "Resume yolo for this session?", "awaited judge-second publication is launch, not a user revision");
  assert.equal(f.dialogs.length, 2, "one original choice and one deliberate resume confirmation");
  assert.equal(sessionYoloSet().has(f.id), false, "stale branch record is not authority");
  assert.equal(store.stages.length, stages, "restoration never stages preferences");
  answer.resolve(true);
  await tick();
  assert.equal(sessionYoloSet().has(f.id), true, "only accepted resume grants yolo");
});

for (const source of ["choice", "judge event"]) {
  test(`awaited same-ID launch cannot retire guards against a newer ${source}`, async (t) => {
    const store = fakeStore({ scope: "global" }), answer = deferred();
    const f = fixture(t, { store, dispatchYield: true, confirm: () => answer.promise });
    await f.start({ id: `awaited-newer-${source}` });
    await f.run("manual");
    await f.start({ id: f.id, saved: [record(f.id, true, ROOT)] });
    assert.equal(f.dialogs.length, 1);
    if (source === "choice") await f.run("manual");
    else f.publish(MANUAL);
    answer.resolve(true);
    await tick();
    assert.equal(sessionYoloSet().has(f.id), false, "late resume cannot overrule a newer user decision");
    assert.equal(f.choice, "approval: manual");
    assert.deepEqual(store.stages.map(({ value }) => value), source === "choice" ? ["manual", "manual"] : ["manual"]);
  });
}

test("save checks shared store identity after confirmation", async (t) => {
  const store = fakeStore(), replacement = fakeStore(), answer = deferred();
  const f = fixture(t, { store, confirm: () => answer.promise });
  await f.start();
  const pending = f.run("save global");
  const cleanup = registerSettingsStore(f.id, replacement);
  t.after(cleanup);
  answer.resolve(true);
  await pending;
  assert.deepEqual(store.stages, []);
  assert.deepEqual(replacement.stages, []);
});

function openApprovalPopover(f) {
  f.events.emit("pi-footer:indicator-click", { key: "approval" });
  assert(f.host.component, "the approval indicator mounts a fullscreen menu");
  return f.host.component;
}

function clickPopoverRow(component, pattern) {
  const width = 60, lines = component.render(width);
  const y = lines.findIndex((line) => typeof pattern === "string" ? line.includes(pattern) : pattern.test(line));
  assert(y > 0, `expected clickable row ${String(pattern)} in ${lines.join("\n")}`);
  component.handleMouse({ type: "click", button: "left", x: 6, y, screenX: 6, screenY: y,
    width, height: lines.length, shift: false, alt: false, ctrl: false });
}

for (const action of [
  { key: "g", scope: "global", label: "global default" },
  { key: "w", scope: "workspace", label: "project default" },
  { key: "G", scope: "global", label: "global default" },
  { key: "W", scope: "workspace", label: "project default" },
  { scope: "global", label: "global default" },
  { scope: "workspace", label: "project default" },
]) {
  test(`fullscreen narrowing leaves the same menu ready to remember ${action.scope} via ${action.key ?? "click"}`, async (t) => {
    const store = fakeStore(), answer = deferred();
    const f = fixture(t, { store, fullscreen: true, confirm: () => answer.promise });
    await f.start();
    const component = openApprovalPopover(f), mounts = f.host.mounts;
    const menu = component.render(60).join("\n");
    assert(menu.includes("[G] Save as global default"));
    assert(menu.includes("[W] Save as project default"));
    assert(menu.includes("Mode changes: this session only"));
    clickPopoverRow(component, /^│. [○●] manual\s/);
    assert.equal(f.choice, "approval: manual");
    assert.equal(f.host.component, component, "narrowing keeps this menu visible");
    assert.equal(f.host.mounts, mounts, "no reopen is needed before remembering");
    assert.deepEqual(store.stages, [], "session-scope mode choices do not stage settings");
    if (action.key) component.handleInput(action.key);
    else clickPopoverRow(component, action.label);
    assert.equal(f.host.component, undefined, "memory action dismisses its menu before confirmation");
    assert.equal(f.dialogs.length, 1);
    const dialog = f.dialogs[0];
    assert.equal(dialog.popoverVisible, false, "confirmation never appears under an approval popover");
    assert.equal(dialog.title, `Save manual as ${action.scope === "global" ? "global" : "project"} approval default?`);
    assert.match(dialog.text, /approval: manual/);
    assert(dialog.text.includes(store.paths[action.scope]));
    assert.match(dialog.text, /Saved on normal exit/);
    assert.match(dialog.text, /preference, not permission/);
    assert.match(dialog.text, /yolo always needs a new explicit confirmation in every session/);
    if (action.scope === "workspace") {
      assert.match(dialog.text, /project config file visible to Git/);
      assert.match(dialog.text, /project-trust prompt in a future Pi session/);
      assert.match(dialog.text, /does not grant project trust/);
    }
    assert.deepEqual(store.stages, [], "nothing is staged before deliberate confirmation");
    answer.resolve(true);
    await tick();
    assert.deepEqual(store.stages, [{ scope: action.scope, path: ["approval"], value: "manual" }]);
    assert.equal(store.scope, "session", "memory buttons do not change the harness-owned shared scope");
    assert.equal(f.choice, "approval: manual");
    assert.equal(sessionYoloSet().has(f.id), false);
    assert(f.notices.some(({ message }) => message === `Approval: manual will be the ${action.scope === "global" ? "global" : "project"} default after normal exit.`));
  });
}

for (const scope of ["session", "global", "workspace"]) {
  test(`fullscreen memory hint exposes the current ${scope} shared scope`, async (t) => {
    const store = fakeStore({ scope });
    const f = fixture(t, { store, fullscreen: true });
    await f.start();
    const component = openApprovalPopover(f);
    const hint = scope === "session" ? "Mode changes: this session only" : `Mode changes: saved for ${scope} on exit`;
    assert(component.render(60).some((line) => line.includes(hint)));
    clickPopoverRow(component, /^│. [○●] manual\s/);
    assert.equal(f.host.component, component);
    assert(component.render(60).some((line) => line.includes(hint)));
    assert.equal(store.scope, scope);
    assert.deepEqual(store.stages.map(({ value }) => value), scope === "session" ? [] : ["manual"]);
  });
}

for (const scope of ["global", "workspace"]) {
  test(`cancelled fullscreen ${scope} remembering never stages or authorizes`, async (t) => {
    const store = fakeStore();
    const f = fixture(t, { store, fullscreen: true, confirm: false });
    await f.start();
    const component = openApprovalPopover(f);
    clickPopoverRow(component, /^│. [○●] manual\s/);
    component.handleInput(scope === "global" ? "g" : "w");
    await tick();
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].popoverVisible, false);
    assert.equal(f.host.component, undefined);
    assert.deepEqual(store.stages, []);
    assert.equal(f.choice, "approval: manual");
    assert.equal(sessionYoloSet().has(f.id), false);
    component.handleInput("g"); component.handleInput("w");
    clickPopoverRow(component, "global default");
    await tick();
    assert.equal(f.dialogs.length, 1, "dismissed memory callbacks have no ownership");
    assert.deepEqual(store.stages, []);
  });
}

test("untrusted fullscreen project remembering is disabled for shortcut and click, not global", async (t) => {
  const store = fakeStore({ trusted: false });
  const f = fixture(t, { store, fullscreen: true });
  await f.start();
  const component = openApprovalPopover(f);
  clickPopoverRow(component, /^│. [○●] manual\s/);
  component.handleInput("w");
  clickPopoverRow(component, "project default");
  await tick();
  assert.equal(f.host.component, component, "disabled action does not dismiss the live menu");
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(store.stages, []);
  assert.equal(sessionYoloSet().has(f.id), false);
  component.handleInput("g");
  await tick();
  assert.deepEqual(store.stages, [{ scope: "global", path: ["approval"], value: "manual" }]);
  assert.equal(store.scope, "session");
});

for (const leave of ["switch", "shutdown", "choice", "trust", "store replacement"]) {
  test(`fullscreen memory confirmation cannot stage after ${leave}`, async (t) => {
    const store = fakeStore(), answer = deferred(), replacement = fakeStore();
    const f = fixture(t, { store, fullscreen: true, confirm: () => answer.promise });
    await f.start();
    const component = openApprovalPopover(f);
    clickPopoverRow(component, /^│. [○●] manual\s/);
    component.handleInput("w");
    assert.equal(f.host.component, undefined);
    assert.equal(f.dialogs[0].popoverVisible, false);
    let nextMenu;
    if (leave === "switch") { await f.start({ store: replacement }); nextMenu = openApprovalPopover(f); }
    else if (leave === "shutdown") f.shutdown();
    else if (leave === "choice") await f.run("manual");
    else if (leave === "trust") store.workspaceTrusted = false;
    else t.after(registerSettingsStore(f.id, replacement));
    const dialogs = f.dialogs.length;
    component.handleInput("g"); component.handleInput("w");
    clickPopoverRow(component, "global default");
    clickPopoverRow(component, "project default");
    if (nextMenu) assert.equal(f.host.component, nextMenu, "stale callbacks cannot dismiss the new menu");
    answer.resolve(true);
    await tick();
    assert.equal(f.dialogs.length, dialogs, "stale callbacks cannot start another confirmation");
    assert.deepEqual(store.stages, []);
    assert.deepEqual(replacement.stages, []);
    assert.equal(sessionYoloSet().has(f.id), false);
  });
}

for (const scope of ["global", "workspace"]) {
  test(`remembering ${scope} from armed yolo saves the actual mode without granting`, async (t) => {
    const store = fakeStore(), answer = deferred();
    const f = fixture(t, { store, fullscreen: true, confirm: () => answer.promise });
    await f.start();
    const component = openApprovalPopover(f);
    component.handleInput("\u001b[F"); component.handleInput("\r");
    assert.equal(component.isArmed(), true);
    assert.equal(f.choice, "approval: jev+sub");
    assert.equal(sessionYoloSet().has(f.id), false);
    if (scope === "global") component.handleInput("g");
    else clickPopoverRow(component, "project default");
    assert.equal(component.isArmed(), false, "memory action disarms the unaccepted mode");
    assert.equal(f.host.component, undefined);
    assert.equal(f.dialogs[0].popoverVisible, false);
    assert.equal(f.dialogs[0].title, `Save judge+sub as ${scope === "global" ? "global" : "project"} approval default?`);
    assert.match(f.dialogs[0].text, /approval: judge\+sub/);
    answer.resolve(true);
    await tick();
    assert.deepEqual(store.stages, [{ scope, path: ["approval"], value: "judge+sub" }]);
    assert.equal(sessionYoloSet().has(f.id), false);
    assert.equal(f.choice, "approval: jev+sub");
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.entries, []);
    component.handleInput("\r");
    assert.equal(sessionYoloSet().has(f.id), false, "retained armed-row callback cannot grant after remembering");
  });
}

test("fullscreen keyboard navigation still selects only modes, never the memory actions", async (t) => {
  const store = fakeStore();
  const f = fixture(t, { store, fullscreen: true });
  await f.start();
  const component = openApprovalPopover(f);
  component.handleInput("\u001b[H"); component.handleInput("\u001b[A"); component.handleInput("\r");
  assert.equal(f.choice, "approval: manual");
  assert.equal(f.host.component, component);
  component.handleInput("\u001b[F"); component.handleInput("\u001b[B"); component.handleInput("\r");
  assert.equal(component.isArmed(), true, "End/Down remain on yolo, requiring second deliberate choice");
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(store.stages, []);
  assert.equal(sessionYoloSet().has(f.id), false);
  component.handleInput("\u001b[H"); component.handleInput("\r");
  assert.equal(component.isArmed(), false);
  assert.equal(f.choice, "approval: manual");
  assert.deepEqual(store.stages, []);
});

test("ordinary Pi has no memory menu or shortcuts and mode choices still close the popover", async (t) => {
  const f = fixture(t, { fullscreen: true });
  await f.start();
  assert.equal(settingsStoreForSession(f.id), undefined);
  const component = openApprovalPopover(f), menu = component.render(60).join("\n");
  assert(!menu.includes("global default"));
  assert(!menu.includes("project default"));
  component.handleInput("g"); component.handleInput("w");
  assert.equal(f.host.component, component);
  assert.deepEqual(f.dialogs, []);
  clickPopoverRow(component, /^│. [○●] manual\s/);
  assert.equal(f.choice, "approval: manual");
  assert.equal(f.host.component, undefined, "ordinary Pi narrowing keeps the original close behavior");
  const yolo = openApprovalPopover(f);
  yolo.handleInput("\u001b[F"); yolo.handleInput("\r"); yolo.handleInput("\r");
  assert.equal(sessionYoloSet().has(f.id), true);
  assert.equal(f.host.component, undefined, "ordinary Pi confirmed mode changes also close");
  assert.deepEqual(f.dialogs, [], "no remembering workflow is installed without the shared store");
});

test("fullscreen global remembering writes only at simulated normal exit and yolo needs fresh session consent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "alehouse-approval-ui-exit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), cwd = join(root, "workspace");
  mkdirSync(agentDir); mkdirSync(cwd);
  const store = new SettingsStore({ agentDir, cwd, projectTrusted: true });
  const f = fixture(t, { store, fullscreen: true });
  await f.start();
  const component = openApprovalPopover(f);
  component.handleInput("\u001b[F"); component.handleInput("\r"); component.handleInput("\r");
  assert.equal(sessionYoloSet().has(f.id), true);
  assert.equal(f.host.component, component);
  component.handleInput("g");
  await tick();
  assert.deepEqual(store.pending(), [{ scope: "global", path: ["approval"], value: "yolo" }]);
  assert.equal(store.scope, "session");
  assert.equal(existsSync(store.paths.global), false, "UI confirmation only stages in memory");
  assert.equal(existsSync(join(cwd, ".pi")), false);
  f.shutdown();
  assert.equal(sessionYoloSet().has(f.id), false);
  assert.equal(existsSync(store.paths.global), false, "approval itself never flushes during shutdown");
  // The harness, not approval-mode, owns the real seal/flush at normal exit.
  store.seal();
  assert.deepEqual(store.flush(), [{ scope: "global", path: store.paths.global }]);
  assert.deepEqual(JSON.parse(readFileSync(store.paths.global, "utf8")), { version: 2, approval: "yolo" });
  const nextStore = new SettingsStore({ agentDir, cwd, projectTrusted: true });
  const next = fixture(t, { store: nextStore, fullscreen: true, confirm: false });
  await next.start();
  assert.equal(next.dialogs.length, 1);
  assert.equal(next.dialogs[0].title, "Turn on yolo for this session?");
  assert.match(next.dialogs[0].text, /explicit denies.*fail-closed floor/s);
  assert.equal(sessionYoloSet().has(next.id), false, "saved yolo is a preference, never inherited authority");
  assert.equal(next.choice, "approval: jev+sub");
  assert.deepEqual(nextStore.pending(), [], "restoration and rejected startup confirmation never stage");
});

for (const scope of ["global", "workspace"]) {
  test(`/approval save ${scope} confirms the actual mode without changing shared scope`, async (t) => {
    const store = fakeStore();
    const f = fixture(t, { store });
    await f.start();
    await f.run("manual");
    await f.run(`save ${scope}`);
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].title, `Save manual as ${scope === "global" ? "global" : "project"} approval default?`);
    assert.match(f.dialogs[0].text, /approval: manual/);
    assert(f.dialogs[0].text.includes(store.paths[scope]));
    assert.match(f.dialogs[0].text, /Saved on normal exit/);
    assert.match(f.dialogs[0].text, /preference, not permission/);
    assert.match(f.dialogs[0].text, /yolo always needs a new explicit confirmation in every session/);
    assert.deepEqual(store.stages, [{ scope, path: ["approval"], value: "manual" }]);
    assert.equal(store.scope, "session");
    assert.equal(sessionYoloSet().has(f.id), false);
  });
}

test("retired remember/default commands are rejected without staging or prompting", async (t) => {
  const store = fakeStore();
  const f = fixture(t, { store });
  await f.start();
  for (const command of ["remember", "remember global", "remember workspace", "default", "default global", "default workspace"]) {
    await f.run(command);
    assert.equal(f.notices.at(-1).level, "error");
  }
  assert.deepEqual(store.stages, []);
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(f.selects, []);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.entries, []);
  assert.equal(f.choice, "approval: jev+sub");
  assert.equal(store.scope, "session");
  assert(f.description.includes("/approval save"));
  assert(!f.description.includes("/approval remember"));
  assert(!f.description.includes("/approval default"));
});

test("/approval save scope selection and UI/trust guards retain the explicit-save contract", async (t) => {
  const store = fakeStore({ trusted: false });
  const f = fixture(t, { store, select: (_title, options) => options.find((label) => label === "All projects") });
  await f.start();
  await f.run("save");
  assert.deepEqual(f.selects[0].choices, ["All projects", "This project"]);
  assert.deepEqual(store.stages, [{ scope: "global", path: ["approval"], value: "judge+sub" }]);
  await f.run("save workspace");
  await f.run("save session");
  f.ctx.hasUI = false;
  await f.run("save global");
  assert.equal(f.dialogs.length, 1, "untrusted, invalid or UI-less defaults never reach confirmation");
  assert.equal(store.stages.length, 1);
  assert.equal(store.scope, "session");
});

test("/approval save dismisses an open popover before confirmation and retires its callbacks", async (t) => {
  const store = fakeStore(), answer = deferred();
  const f = fixture(t, { store, fullscreen: true, confirm: () => answer.promise,
    select: (_title, options) => options.find((label) => label === "All projects") });
  await f.start();
  const oldMenu = openApprovalPopover(f);
  let settled = false;
  const pending = f.run("save").then(() => { settled = true; });
  assert.equal(f.host.component, undefined, "the command yields its own menu before any dialog");
  await tick();
  assert.equal(f.selects.length, 1);
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].title, "Save judge+sub as global approval default?");
  assert.equal(f.dialogs[0].popoverVisible, false, "command confirmation cannot appear under the menu");
  const replayOldCallbacks = () => {
    oldMenu.handleInput("\u001b");
    oldMenu.handleInput("\u001b[H"); oldMenu.handleInput("\r");
    oldMenu.handleInput("\u001b[F"); oldMenu.handleInput("\r"); oldMenu.handleInput("\r");
    oldMenu.handleInput("G"); oldMenu.handleInput("W");
    clickPopoverRow(oldMenu, "global default");
    clickPopoverRow(oldMenu, "project default");
  };
  replayOldCallbacks();
  await tick();
  assert.equal(settled, false, "retained menu callbacks cannot complete or dismiss the pending confirmation");
  assert.equal(f.dialogs.length, 1, "retained save callbacks cannot open another dialog");
  assert.deepEqual(store.stages, []);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.entries, []);
  assert.equal(f.choice, "approval: jev+sub");
  assert.equal(sessionYoloSet().has(f.id), false);
  answer.resolve(true);
  await pending;
  assert.deepEqual(store.stages, [{ scope: "global", path: ["approval"], value: "judge+sub" }]);
  assert.equal(store.scope, "session");
  const nextMenu = openApprovalPopover(f);
  assert.notEqual(nextMenu, oldMenu);
  replayOldCallbacks();
  await tick();
  assert.equal(f.host.component, nextMenu, "retained close callbacks cannot dismiss a later menu");
  assert.equal(f.dialogs.length, 1);
  assert.deepEqual(store.stages, [{ scope: "global", path: ["approval"], value: "judge+sub" }]);
  assert.deepEqual(f.requests, []);
  assert.equal(sessionYoloSet().has(f.id), false);
});

test("fullscreen and slash save actions share one pending confirmation per epoch", async (t) => {
  const store = fakeStore(), answer = deferred();
  let confirmations = 0;
  const f = fixture(t, { store, fullscreen: true,
    confirm: () => ++confirmations === 1 ? answer.promise : true });
  await f.start();
  const component = openApprovalPopover(f);
  clickPopoverRow(component, /^│. [○●] manual\s/);
  component.handleInput("g");
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].popoverVisible, false);
  await f.run("save workspace");
  await f.run("save global");
  assert.equal(f.dialogs.length, 1, "competing saves cannot open another dialog");
  assert.deepEqual(store.stages, []);
  answer.resolve(false);
  await tick();
  assert.deepEqual(store.stages, []);
  const retry = openApprovalPopover(f);
  retry.handleInput("w");
  await tick();
  assert.equal(f.dialogs.length, 2, "cancellation releases the latch for a new explicit action");
  assert.equal(f.dialogs[1].popoverVisible, false);
  assert.deepEqual(store.stages, [{ scope: "workspace", path: ["approval"], value: "manual" }]);
  assert.equal(store.scope, "session");
});

test("an old save dialog cannot stage or unlock the new epoch's pending project confirmation", async (t) => {
  const oldStore = fakeStore(), nextStore = fakeStore(), first = deferred(), second = deferred();
  let confirmations = 0;
  const f = fixture(t, { store: oldStore, fullscreen: true,
    confirm: () => ++confirmations === 1 ? first.promise : second.promise });
  await f.start();
  const oldMenu = openApprovalPopover(f);
  clickPopoverRow(oldMenu, /^│. [○●] manual\s/);
  oldMenu.handleInput("g");
  await f.start({ store: nextStore });
  const nextMenu = openApprovalPopover(f);
  clickPopoverRow(nextMenu, /^│. [○●] manual\s/);
  nextMenu.handleInput("w");
  assert.equal(f.dialogs.length, 2, "new session owns a fresh confirmation latch");
  assert(f.dialogs.every(({ popoverVisible }) => !popoverVisible));
  first.resolve(true);
  await tick();
  assert.deepEqual(oldStore.stages, []);
  assert.deepEqual(nextStore.stages, []);
  oldMenu.handleInput("g");
  await f.run("save global");
  assert.equal(f.dialogs.length, 2, "settling an old epoch cannot unlock the new pending action");
  second.resolve(true);
  await tick();
  assert.deepEqual(oldStore.stages, []);
  assert.deepEqual(nextStore.stages, [{ scope: "workspace", path: ["approval"], value: "manual" }]);
  assert.equal(nextStore.scope, "session");
  assert.equal(sessionYoloSet().has(f.id), false);
});
