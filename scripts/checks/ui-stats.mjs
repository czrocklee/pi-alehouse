// UI stats checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { join } from "node:path";
export function registerStatsTests(
  statsExtension,
  healthStatus,
  SessionStats,
  WorkerStats,
  fixture,
  footerExtension,
  TuiAltScreen,
  STATS_WORKER_ATTACH,
  HEALTH_INDICATOR,
  WORKER_PRESET_INDICATOR,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  FOOTER_INDICATOR_CLICK_EVENT,
  root,
  extensions,
) {
  const DOT = Object.freeze({
    busy: "●accent",
    waiting: "●warning",
    error: "●error",
    idle: "●dim",
  });

  async function mountStats(mode = "fullscreen", hasUI = true) {
    const f = fixture();
    const terminal = { rows: 40, columns: 120, hideCursor() {} };
    const tui = new TuiAltScreen(terminal, false, undefined, {});
    tui.requestRender = () => {};
    const host =
      mode === "fullscreen" ? tui : { mode, terminal, render: () => [], requestRender() {} };
    const editor = { render: () => [], invalidate() {}, handleInput() {} };
    tui.setFocus(editor);
    const theme = {
      fg: (role, text) => (text === "●" ? `●${role}` : text),
      bold: (text) => text,
      bg: (_role, text) => text,
    };
    const statuses = new Map([
      ["approval", "approval: manual"],
      [WORKER_PRESET_INDICATOR, "workers: fixture-strong"],
    ]);
    const commands = new Map(),
      notices = [];
    f.pi.registerCommand = (name, command) => commands.set(name, command);
    f.ctx.hasUI = hasUI;
    f.ctx.sessionManager = { getEntries: () => [], getSessionId: () => "stats-root" };
    f.ctx.model = { provider: "fixture", id: "requested", reasoning: false };
    f.ctx.getContextUsage = () => undefined;
    let footer;
    Object.assign(f.ctx.ui, {
      theme,
      setStatus: (key, text) =>
        text === undefined ? statuses.delete(key) : statuses.set(key, text),
      notify: (message, level) => notices.push({ message, level }),
      setWidget(key, factory) {
        f.widgets.delete(key);
        if (factory) f.widgets.set(key, factory(host, theme));
      },
      setFooter(factory) {
        footer?.dispose();
        footer = factory(host, theme, {
          getGitBranch: () => "main",
          getExtensionStatuses: () => statuses,
          onBranchChange: () => () => {},
        });
      },
    });
    footerExtension(f.pi);
    statsExtension(f.pi);
    await f.emit("session_start");
    const line = () => footer.render(terminal.columns)[0];
    return {
      f,
      tui,
      terminal,
      statuses,
      commands,
      notices,
      editor,
      line,
      pane: () =>
        tui.overlayStack.find((entry) => entry.component.constructor.name === "StatsView")
          ?.component,
      click() {
        const text = line(),
          label = statuses.get(HEALTH_INDICATOR);
        return footer.handleMouse({ type: "click", button: "left", x: text.indexOf(label), y: 0 });
      },
      paint() {
        return tui.compositeOverlays(
          Array(terminal.rows).fill(""),
          terminal.columns,
          terminal.rows,
        );
      },
      async close() {
        await f.emit("session_shutdown");
        footer.dispose();
      },
    };
  }

  test("health is one dot whose color is the attention state, not a fabricated green score", () => {
    const theme = { fg: (role, text) => `${role}:${text}` };
    assert.deepEqual(
      ["unknown", "idle", "busy", "waiting", "error"].map((health) => healthStatus(theme, health)),
      ["dim:●", "dim:●", "accent:●", "warning:●", "error:●"],
    );
  });

  test("the health footer opens a separate Stats view and closes without popping another overlay", async () => {
    const m = await mountStats();
    try {
      assert(m.line().endsWith(`fixture-strong · manual · ${DOT.idle}`));
      assert.equal(m.click().handled, true);
      m.paint();
      const pane = m.pane();
      assert(pane);
      const entry = m.tui.overlayStack.find((entry) => entry.component === pane);
      assert.equal(entry.options.anchor, "center", "Stats is not another small stacked popover");
      assert.match(pane.render(100).join("\n"), /Stats/);
      assert.equal(m.tui.getFocusedComponent(), pane);
      const unrelated = { render: () => ["unrelated"], invalidate() {} };
      const handle = m.tui.showOverlay(unrelated, {
        anchor: "top-left",
        width: 20,
        nonCapturing: true,
      });
      await m.commands.get("stats").handler("", m.f.ctx);
      assert.equal(m.pane(), undefined);
      assert(
        m.tui.overlayStack.some((entry) => entry.component === unrelated),
        "exact-handle close leaves newer overlays alone",
      );
      handle.hide();
      assert.equal(m.tui.getFocusedComponent(), m.editor);
      m.click();
      m.paint();
      m.pane().handleInput("\u001b");
      assert.equal(m.pane(), undefined);
    } finally {
      await m.close();
    }
  });

  test("Stats yields to approvals and other dialogs, and never reopens from a stale notification", async () => {
    const m = await mountStats();
    try {
      m.click();
      m.f.pi.events.emit("permissions:ui_prompt", { requestId: "ask" });
      assert.equal(m.pane(), undefined);
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.waiting);
      m.click();
      assert.equal(m.pane(), undefined, "cannot cover an active approval");
      m.f.pi.events.emit("permissions:decision", { requestId: "ask" });
      assert.equal(m.pane(), undefined, "a stats window is not a reopen intent");
      m.click();
      assert(m.pane());
      await m.f.emit("ui_prompt_start", { kind: "confirm", reason: "ui_prompt" });
      assert.equal(m.pane(), undefined);
      m.click();
      assert.equal(m.pane(), undefined);
      await m.f.emit("ui_prompt_end", { kind: "confirm", reason: "ui_prompt" });
      m.click();
      assert(m.pane());
      m.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
      assert.equal(m.pane(), undefined, "cooperatively closes during agent panel settlement");
    } finally {
      await m.close();
    }
  });

  test("Stats session replacement clears live observations and shutdown retires listeners and refresh", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const m = await mountStats();
    try {
      await m.f.emit("agent_start");
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.busy);
      await m.f.emit("turn_start", { turnIndex: 0 });
      await m.f.emit("before_provider_request", { payload: {} });
      await m.f.emit("message_update", {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "NOT_RETAINED" },
      });
      await m.f.emit("message_end", {
        message: {
          role: "assistant",
          provider: "fixture",
          model: "requested",
          responseModel: "answered",
          stopReason: "stop",
          usage: { output: 10, cost: { total: 0.01 } },
        },
      });
      await m.f.emit("agent_settled");
      m.click();
      assert(m.pane());
      await m.f.emit("session_start");
      assert.equal(m.pane(), undefined);
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.idle);
      assert.equal(
        m.f.listeners.get(FOOTER_INDICATOR_CLICK_EVENT).size,
        1,
        "replacement never duplicates the toggle",
      );
      m.click();
      assert(m.pane());
      await m.f.emit("session_shutdown");
      assert.equal(m.pane(), undefined);
      assert.equal(m.statuses.has(HEALTH_INDICATOR), false);
      assert.equal(m.f.widgets.has("stats-host"), false);
      t.mock.timers.tick(5000);
      assert.equal(m.statuses.has(HEALTH_INDICATOR), false);
      const click = { key: HEALTH_INDICATOR, handled: false };
      m.f.pi.events.emit(FOOTER_INDICATOR_CLICK_EVENT, click);
      assert.equal(click.handled, false);
      assert.equal(m.pane(), undefined);
    } finally {
      await m.close();
    }
  });

  test("regular Stats uses a non-modal summary and no-UI sessions mount nothing", async () => {
    for (const hasUI of [true, false]) {
      const m = await mountStats("regular", hasUI);
      try {
        await m.commands.get("stats").handler("", m.f.ctx);
        assert.equal(m.pane(), undefined);
        assert.equal(m.notices.length, hasUI ? 1 : 0);
        if (hasUI)
          assert.match(
            m.notices[0].message,
            /main session \+ managed workers, since opening\n\nTime +Main +Workers\nBusy /,
          );
        else assert.equal(m.statuses.has(HEALTH_INDICATOR), false);
      } finally {
        await m.close();
      }
    }
  });

  test("Stats includes owned workers, retains released metrics and rejects foreign/stale attachments", async () => {
    const m = await mountStats();
    const attach = (parentId, workerId) => {
      const request = { parentId, workerId };
      m.f.pi.events.emit(STATS_WORKER_ATTACH, request);
      return request.sink;
    };
    try {
      assert.equal(attach("another-owner", "agent-a"), undefined);
      const sink = attach("stats-root", "agent-a");
      assert(sink);
      assert.equal(
        attach("stats-root", "agent-a"),
        sink,
        "duplicate attachment does not reset or duplicate a collector",
      );
      sink.beginRun();
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.busy,
        "a worker keeps health busy even while the parent is idle",
      );
      sink.startActivity();
      sink.requestStart("requested", "fixture");
      sink.delta("thinking_delta");
      sink.messageEnd({
        role: "assistant",
        provider: "fixture",
        model: "requested",
        responseModel: "worker-actual",
        stopReason: "stop",
        usage: { output: 20, cost: { total: 0.03 } },
      });
      sink.toolStart("call-a", "read");
      sink.toolEnd("call-a", false);
      sink.endRun("success");
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.idle);
      m.click();
      m.pane().handleInput("2");
      assert.match(m.pane().render(140).join("\n"), /Workers[\s│]*fixture\/worker-actual +1 /);
      sink.dispose();
      sink.dispose();
      const saved = m.pane().render(140).join("\n");
      assert.match(
        saved,
        /Workers[\s│]*fixture\/worker-actual +1 /,
        "release retains historical totals, not the SDK session",
      );
      sink.beginRun();
      sink.requestStart("STALE_MODEL", "fixture");
      sink.messageEnd({
        role: "assistant",
        model: "STALE_MODEL",
        stopReason: "stop",
        usage: { output: 999 },
      });
      assert.doesNotMatch(m.pane().render(140).join("\n"), /STALE_MODEL/);
      const late = attach("stats-root", "agent-b");
      late.beginRun();
      await m.f.emit("session_start");
      late.requestStart("OLD_WINDOW", "fixture");
      late.endRun("error");
      late.dispose();
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.idle,
        "callbacks from the old window cannot revive worker health",
      );
      m.click();
      m.pane().handleInput("2");
      assert.doesNotMatch(m.pane().render(140).join("\n"), /worker-actual|OLD_WINDOW/);
    } finally {
      await m.close();
    }
  });

  test("health transitions and streaming never build detail snapshots; tool errors stay in counters", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const mainSnapshot = SessionStats.prototype.snapshot,
      workerSnapshot = WorkerStats.prototype.snapshot;
    let mainReads = 0,
      workerReads = 0;
    t.mock.method(SessionStats.prototype, "snapshot", function () {
      mainReads++;
      return mainSnapshot.call(this);
    });
    t.mock.method(WorkerStats.prototype, "snapshot", function () {
      workerReads++;
      return workerSnapshot.call(this);
    });
    const m = await mountStats();
    try {
      const request = { parentId: "stats-root", workerId: "live-worker" };
      m.f.pi.events.emit(STATS_WORKER_ATTACH, request);
      const sink = request.sink;
      sink.beginRun();
      sink.startActivity();
      sink.requestStart("worker", "fixture");
      await m.f.emit("agent_start");
      await m.f.emit("turn_start", { turnIndex: 0 });
      for (let index = 0; index < 1000; index++) {
        await m.f.emit("message_update", {
          assistantMessageEvent: { type: "text_delta", delta: "observed" },
        });
        sink.delta("text_delta");
      }
      await m.f.emit("tool_execution_start", { toolCallId: "check", toolName: "bash" });
      await m.f.emit("tool_execution_end", { toolCallId: "check", isError: true });
      sink.toolStart("worker-check", "bash");
      sink.toolEnd("worker-check", true, 0);
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.busy,
        "neither tool error is a fatal health signal",
      );
      const failure = (model) => ({
        role: "assistant",
        provider: "fixture",
        model,
        stopReason: "error",
      });
      await m.f.emit("message_end", { message: failure("requested") });
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.error);
      m.f.pi.events.emit("permissions:ui_prompt", { requestId: "permission" });
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.waiting);
      m.f.pi.events.emit("permissions:decision", { requestId: "permission", decision: "deny" });
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.error);
      await m.f.emit("agent_settled");
      await m.f.emit("agent_start");
      await m.f.emit("agent_settled");
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.busy,
        "worker is still running after parent recovery",
      );
      sink.messageEnd(failure("worker"));
      sink.endRun("error");
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.error,
        "actual worker failure is immediately visible",
      );
      t.mock.timers.tick(3000);
      sink.beginRun();
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.busy);
      sink.endRun("success");
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.idle);
      assert.deepEqual(
        [mainReads, workerReads],
        [0, 0],
        "streaming, transitions and refresh use only cheap health reads",
      );
      m.click();
      m.pane().handleInput("3");
      const details = m.pane().render(140).join("\n");
      assert.match(details, /Main[\s│]*bash +1 +1 /);
      assert.match(details, /Workers[\s│]*bash +1 +1 /, "both tool error counts remain visible");
      assert(
        mainReads > 0 && workerReads > 0,
        "full snapshots are requested when the details view actually paints",
      );
    } finally {
      await m.close();
    }
  });

  test("red health clears once something succeeds after it, and Stats says what failed", async () => {
    const m = await mountStats();
    try {
      const request = { parentId: "stats-root", workerId: "a7" };
      m.f.pi.events.emit(STATS_WORKER_ATTACH, request);
      const sink = request.sink;
      sink.beginRun();
      sink.startActivity();
      sink.requestStart("glm", "zai");
      sink.messageEnd({
        role: "assistant",
        provider: "zai",
        model: "glm",
        stopReason: "error",
        errorMessage: "429 rate limited",
      });
      sink.settleActivity();
      sink.endRun("error");
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.error);

      // The parent's next run retries a failed response and then succeeds.
      const response = (stopReason, errorMessage) => ({
        message: {
          role: "assistant",
          provider: "fixture",
          model: "requested",
          stopReason,
          ...(errorMessage ? { errorMessage } : {}),
          usage: { output: 1, cost: { total: 0 } },
        },
      });
      await m.f.emit("agent_start");
      await m.f.emit("turn_start", { turnIndex: 0 });
      await m.f.emit("message_end", response("error", "overloaded"));
      await m.f.emit("turn_start", { turnIndex: 1 });
      await m.f.emit("message_end", response("stop"));
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.error,
        "the idle worker's failure still stands mid-run",
      );
      m.click();
      m.paint();
      const details = m.pane().render(140).join("\n");
      assert.match(details, /! a7 +\S.* +zai\/glm +429 rate limited/);
      assert.match(
        details,
        /· main +\S.* +fixture\/requested +overloaded/,
        "the retried main failure is already cleared",
      );
      m.pane().handleInput("\u001b");
      await m.f.emit("agent_settled");
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.idle,
        "a successful parent run clears a worker that was never resumed",
      );

      // A run that ends failed stays red after it settles, until something succeeds.
      await m.f.emit("agent_start");
      await m.f.emit("turn_start", { turnIndex: 0 });
      await m.f.emit("message_end", response("error"));
      await m.f.emit("agent_settled");
      assert.equal(m.statuses.get(HEALTH_INDICATOR), DOT.error);
    } finally {
      await m.close();
    }
  });

  test("an aborted parent run keeps a worker failure red, even after its successful toolUse response", async () => {
    const m = await mountStats();
    try {
      const request = { parentId: "stats-root", workerId: "a7" };
      m.f.pi.events.emit(STATS_WORKER_ATTACH, request);
      const sink = request.sink;
      const response = (stopReason) => ({
        message: {
          role: "assistant",
          provider: "fixture",
          model: "requested",
          stopReason,
          usage: { output: 1, cost: { total: 0 } },
        },
      });
      await m.f.emit("agent_start");
      await m.f.emit("turn_start", { turnIndex: 0 });
      await m.f.emit("message_end", response("toolUse"));
      await m.f.emit("tool_execution_start", {
        toolCallId: "wait",
        toolName: "agent_wait",
        args: {},
      });
      sink.beginRun();
      sink.startActivity();
      sink.requestStart("glm", "zai");
      sink.messageEnd({
        role: "assistant",
        provider: "zai",
        model: "glm",
        stopReason: "error",
        errorMessage: "429 rate limited",
      });
      sink.settleActivity();
      sink.endRun("error");
      // Esc: the wait ends aborted and the SDK reports the run outside any request.
      await m.f.emit("tool_execution_end", {
        toolCallId: "wait",
        toolName: "agent_wait",
        result: {},
        isError: true,
      });
      await m.f.emit("message_end", response("aborted"));
      await m.f.emit("agent_settled");
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.error,
        "nothing has seen the failure succeed or been answered",
      );

      await m.f.emit("agent_start");
      await m.f.emit("turn_start", { turnIndex: 0 });
      await m.f.emit("message_end", response("stop"));
      await m.f.emit("agent_settled");
      assert.equal(
        m.statuses.get(HEALTH_INDICATOR),
        DOT.idle,
        "the next run that answers clears it",
      );
    } finally {
      await m.close();
    }
  });

  test("removed task-list extension is neither deployed nor permitted", () => {
    assert(!existsSync(join(extensions, "todo.ts")));
    const composition = readFileSync(join(root, "src/composition.ts"), "utf8");
    assert(!composition.includes("extensions/todo.ts"));
    const config = JSON.parse(readFileSync(join(root, "resources/permissions.json"), "utf8"));
    assert(!Object.hasOwn(config.permission, "todo"));
  });
}
