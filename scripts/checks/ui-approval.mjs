// UI approval checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
export function registerApprovalTests(
  approvalExtension,
  ApprovalPopover,
  APPROVAL_ENTRY,
  approvalChoices,
  approvalStatus,
  currentChoice,
  SESSION_YOLO_KEY,
  managedSessionYolo,
  fixture,
  TuiAltScreen,
  joinPopoverStack,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  FOOTER_INDICATOR_CLICK_EVENT,
  FOOTER_HEIGHT,
  nextTick,
) {
  const plainTheme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    bg: (_color, text) => text,
  };
  const yoloSet = () => globalThis[SESSION_YOLO_KEY] ?? new Set();

  test("approval choices follow the loaded judge, and yolo is always offered", () => {
    assert.deepEqual(
      approvalChoices(undefined).map((choice) => choice.id),
      ["manual", "yolo"],
    );
    assert.deepEqual(
      approvalChoices("jev").map((choice) => choice.label),
      ["manual", "jev", "jev + sub", "yolo"],
    );
    const jev = (mode, includeSubagents) => ({ judge: "jev", mode, includeSubagents, shown: true });
    assert.equal(currentChoice(undefined, false), "manual");
    assert.equal(currentChoice(jev("shadow", false), false), "manual");
    assert.equal(currentChoice(jev("enforce", false), false), "judge");
    assert.equal(currentChoice(jev("enforce", true), false), "judge+sub");
    assert.equal(
      currentChoice(jev("enforce", true), true),
      "yolo",
      "yolo wins over any judge mode",
    );
    const colors = [];
    const recording = {
      fg: (color, text) => {
        colors.push(color);
        return `<${color}>${text}`;
      },
      bold: (text) => text,
    };
    assert.equal(approvalStatus(recording, jev("enforce", true), false), "approval: jev+sub");
    assert.equal(approvalStatus(recording, jev("enforce", false), false), "approval: jev");
    assert.equal(approvalStatus(recording, undefined, false), "approval: manual");
    assert.equal(
      approvalStatus(recording, jev("enforce", true), true),
      "approval: <error>YOLO",
      "yolo is loud",
    );
  });

  /** A session record as approval-mode writes it. */
  const choiceEntry = (sessionId, yolo, judge) => ({
    type: "custom",
    customType: APPROVAL_ENTRY,
    data: { sessionId, yolo, ...(judge ? { judge } : {}) },
  });
  const SUB = { mode: "enforce", includeSubagents: true };
  const ROOT = { mode: "enforce", includeSubagents: false };
  const MANUAL = { mode: "shadow", includeSubagents: false };

  /** The approval extension on a real alternate-screen compositor. */
  async function mountApproval({
    branch = [],
    mode = "fullscreen",
    judges = true,
    judgeFirst = false,
    launch = SUB,
    confirm = true,
    select,
    appendThrows = false,
    sessionId: initial = "approval-root",
    sdkDispatch = false,
  } = {}) {
    const f = fixture("tui", sdkDispatch);
    const entries = [],
      notices = [],
      statuses = new Map(),
      commands = new Map(),
      setRequests = [],
      dialogs = [];
    const terminal = { rows: 30, columns: 120, hideCursor() {} };
    const tui = new TuiAltScreen(terminal, false, undefined, {});
    Object.defineProperty(tui, "mode", { value: mode });
    tui.requestRender = () => {};
    const failing = { append: appendThrows };
    f.pi.registerCommand = (name, command) => commands.set(name, command);
    f.pi.appendEntry = (customType, data) => {
      if (failing.append) throw new Error("disk full");
      entries.push({ type: "custom", customType, data });
    };
    let sessionId = initial;
    // The fixture hands its own context to every handler it emits to.
    const ctx = Object.assign(f.ctx, {
      mode: "tui",
      hasUI: true,
      cwd: "/fixture",
      ui: {
        theme: plainTheme,
        setStatus: (key, value) => {
          if (value === undefined) statuses.delete(key);
          else statuses.set(key, value);
        },
        notify: (message, level) => notices.push({ level, message }),
        setWidget: (_key, factory) => {
          factory?.(tui, plainTheme);
        },
        select: async (_title, options) => select?.(options),
        confirm: async (title, text) => {
          dialogs.push({ title, text });
          return typeof confirm === "function" ? confirm(title) : confirm;
        },
      },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [...branch, ...entries] },
    });
    approvalExtension(f.pi);
    // A stand-in judge that owns its mode, as jev does: each session
    // starts from the launch mode, and every publish names its session.
    const judge = { judge: "jev", ...launch };
    const publish = () =>
      f.pi.events.emit("approval:judge-state", { ...judge, sessionId, shown: false });
    if (judges)
      f.pi.events.on("approval:set-judge", (request) => {
        setRequests.push({ mode: request.mode, includeSubagents: request.includeSubagents });
        request.applied = true;
        Object.assign(judge, { mode: request.mode, includeSubagents: request.includeSubagents });
        publish();
      });
    const start = async () => {
      Object.assign(judge, launch);
      if (judges && judgeFirst) publish();
      await f.emit("session_start", {});
      if (judges && !judgeFirst) publish();
      await nextTick();
    };
    await start();
    const overlays = () => tui.overlayStack.filter((entry) => !entry.hidden);
    const popover = () =>
      overlays()
        .map((entry) => entry.component)
        .find((component) => component instanceof ApprovalPopover);
    const lines = () =>
      popover()
        ?.render(60)
        .map((line) => stripVTControlCharacters(line)) ?? [];
    const click = (x, y, extra = {}) =>
      popover().handleMouse({
        type: "click",
        button: "left",
        x,
        y,
        screenX: x,
        screenY: y,
        width: 60,
        height: 10,
        shift: false,
        alt: false,
        ctrl: false,
        ...extra,
      });
    const clickRow = (label) => {
      const rows = lines();
      const y = rows.findIndex((line) =>
        new RegExp(`^│. . ${label.replace(/[+]/g, "\\+")} `).test(line),
      );
      assert(y > 0, `row ${label} in ${rows.join("\n")}`);
      click(5, y);
    };
    const indicator = () => {
      const click = { key: "approval", handled: false };
      f.pi.events.emit("pi-footer:indicator-click", click);
      return click.handled;
    };
    /** Open the popover and pick a row, twice when it arms first. */
    const pick = (label) => {
      if (!popover()) indicator();
      clickRow(label);
      if (popover()?.isArmed()) clickRow(label);
    };
    return {
      f,
      tui,
      ctx,
      entries,
      notices,
      statuses,
      commands,
      setRequests,
      dialogs,
      judge,
      publish,
      popover,
      lines,
      click,
      clickRow,
      indicator,
      pick,
      failing,
      switchSession: async (id, restored = []) => {
        sessionId = id;
        branch = restored;
        entries.length = 0;
        await start();
      },
      /** /tree: the leaf moves to the first `length` entries of the current branch. */
      navigate: async (length) => {
        branch = [...branch, ...entries].slice(0, length);
        entries.length = 0;
        await f.emit("session_tree", {});
      },
      history: () => [...branch, ...entries],
      shutdown: () => f.emit("session_shutdown", {}),
    };
  }

  /** Fail real compositor/column cleanup, not a stand-in close implementation. */
  function failApprovalTeardown(m, point) {
    const calls = [],
      grantsDuringUi = [];
    let armed = false,
      insideHide = false,
      afterHideRenders = 0,
      originalHide;
    const show = m.tui.showOverlay.bind(m.tui),
      render = m.tui.requestRender;
    const setStatus = m.ctx.ui.setStatus,
      setWidget = m.ctx.ui.setWidget;
    const hit = (part) => {
      if (!armed) return;
      calls.push(part);
      grantsDuringUi.push(
        managedSessionYolo("approval-root", new Map()) ||
          managedSessionYolo("approval-next", new Map()),
      );
      if (point === part || point === "all") throw new Error(`UI_${part.toUpperCase()}`);
    };
    m.tui.showOverlay = (...args) => {
      const handle = show(...args);
      originalHide = handle.hide.bind(handle);
      handle.hide = () => {
        hit("hide");
        insideHide = true;
        try {
          originalHide();
        } finally {
          insideHide = false;
        }
      };
      return handle;
    };
    m.indicator();
    m.lines();
    const component = m.popover();
    // A member above the measured approval pane makes its leave() request a
    // repaint. This tests a throwing real leave(), separately from hide/render.
    const above = joinPopoverStack(m.tui);
    above.measure(2);
    m.tui.requestRender = () => {
      if (!armed) return render();
      if (insideHide) {
        calls.push("hide-render");
        return;
      }
      hit(++afterHideRenders === 1 ? "leave" : "render");
    };
    m.ctx.ui.setStatus = (...args) => {
      hit("status");
      return setStatus(...args);
    };
    m.ctx.ui.setWidget = (...args) => {
      hit("widget");
      return setWidget(...args);
    };
    return {
      calls,
      grantsDuringUi,
      above,
      component,
      arm() {
        armed = true;
      },
      restore() {
        armed = false;
        m.tui.showOverlay = show;
        m.tui.requestRender = render;
        m.ctx.ui.setStatus = setStatus;
        m.ctx.ui.setWidget = setWidget;
        originalHide?.();
        above.leave();
      },
    };
  }

  for (const point of ["hide", "leave", "render", "status", "widget", "all"]) {
    test(`approval shutdown revokes before UI cleanup and attempts every cleanup despite ${point} failure`, async () => {
      const m = await mountApproval({ sdkDispatch: true });
      m.pick("yolo");
      const chain = new Map([["approval-child", { parentSessionId: "approval-root" }]]);
      assert.equal(managedSessionYolo("approval-child", chain), true);
      const fault = failApprovalTeardown(m, point);
      try {
        fault.arm();
        await m.shutdown();
        assert.equal(managedSessionYolo("approval-root", chain), false);
        assert.equal(managedSessionYolo("approval-child", chain), false);
        assert(
          fault.grantsDuringUi.every((granted) => !granted),
          "revocation precedes the first UI call",
        );
        for (const part of ["hide", "leave", "render", "status", "widget"])
          assert(fault.calls.includes(part), `${part}: ${fault.calls}`);
        assert.equal(fault.above.bottom, 1, "failed hide/leave must not retain the column slot");
        assert.deepEqual(
          m.f.errors,
          [],
          "expected UI failures are contained, not left to the dispatcher",
        );
      } finally {
        fault.restore();
        await m.shutdown();
      }
    });
  }

  for (const source of ["command", "restore"])
    for (const leave of ["switch", "shutdown"])
      for (const point of ["hide", "render"]) {
        test(`late ${source} confirmation and stale popover cannot grant after ${leave} with ${point} failure`, async () => {
          let answer;
          const m = await mountApproval({
            sdkDispatch: true,
            branch: source === "restore" ? [choiceEntry("approval-root", true, SUB)] : [],
            confirm: () =>
              new Promise((resolve) => {
                answer = resolve;
              }),
          });
          const fault = failApprovalTeardown(m, point);
          const pending =
            source === "command" ? m.commands.get("approval").handler("yolo", m.ctx) : undefined;
          await nextTick();
          // Arm the old popover too. Its retained callback must not act for a new
          // session even if a failed hide leaves that component on the old renderer.
          fault.component.handleInput("\u001b[F");
          fault.component.handleInput("\r");
          assert.equal(fault.component.isArmed(), true);
          try {
            fault.arm();
            if (leave === "switch") await m.switchSession("approval-next");
            else await m.shutdown();
            answer(true);
            await pending;
            await nextTick();
            fault.component.handleInput("\r");
            assert.equal(managedSessionYolo("approval-root", new Map()), false);
            assert.equal(managedSessionYolo("approval-next", new Map()), false);
            assert.equal(
              m.entries.some((entry) => entry.data?.yolo),
              false,
            );
            assert.deepEqual(m.f.errors, []);
          } finally {
            fault.restore();
            await m.shutdown();
          }
        });
      }

  test("session start revokes old and stale incoming grants before a failing old popover is touched", async () => {
    const m = await mountApproval({ sdkDispatch: true });
    m.pick("yolo");
    const fault = failApprovalTeardown(m, "hide");
    yoloSet().add("approval-next");
    try {
      fault.arm();
      await m.switchSession("approval-next");
      assert(fault.grantsDuringUi.every((granted) => !granted));
      assert.equal(managedSessionYolo("approval-root", new Map()), false);
      assert.equal(managedSessionYolo("approval-next", new Map()), false);
      assert.equal(m.statuses.get("approval"), "approval: jev+sub");
      assert.deepEqual(m.f.errors, []);
    } finally {
      fault.restore();
      await m.shutdown();
      yoloSet().delete("approval-next"); // Isolate even the unfixed startup negative control.
    }
  });

  test("a fresh approval instance clears a stale same-ID grant rather than displaying manual over YOLO", async () => {
    yoloSet().add("approval-root");
    const m = await mountApproval({ sdkDispatch: true, judges: false });
    try {
      assert.equal(managedSessionYolo("approval-root", new Map()), false);
      assert.equal(m.statuses.get("approval"), "approval: manual");
    } finally {
      await m.shutdown();
    }
  });

  test("the approval indicator renders the judge's mode and claims it from the judge", async () => {
    const m = await mountApproval();
    try {
      assert.equal(m.statuses.get("approval"), "approval: jev+sub");
      const state = {
        judge: "jev",
        mode: "shadow",
        includeSubagents: false,
        sessionId: "approval-root",
        shown: false,
      };
      m.f.pi.events.emit("approval:judge-state", state);
      assert.equal(
        state.shown,
        true,
        "an indicator that renders the mode claims it, so the judge drops its own status",
      );
      assert.equal(m.statuses.get("approval"), "approval: manual");
      m.f.pi.events.emit("approval:judge-state", { judge: "other", mode: "enforce", shown: false });
      assert.equal(
        m.statuses.get("approval"),
        "approval: manual",
        "malformed judge state is ignored",
      );
    } finally {
      await m.shutdown();
    }
    assert.equal(m.statuses.has("approval"), false, "shutdown clears the indicator");
  });

  test("the approval popover is a menu: narrowing applies at once, widening takes a second choice", async () => {
    const m = await mountApproval();
    try {
      assert.equal(m.indicator(), true, "the footer click is claimed");
      const lines = m.lines();
      assert.match(lines[0], /^╭─ Approval ─+ × ─╮$/);
      assert.deepEqual(
        lines.slice(1, 5).map((line) => line.slice(1, 16).trim()),
        ["○ manual", "○ jev", "› ● jev + sub", "○ yolo"],
      );
      m.clickRow("jev");
      assert.deepEqual(m.setRequests.at(-1), ROOT, "jev + sub to jev narrows: one click");
      assert.equal(m.statuses.get("approval"), "approval: jev");
      assert.equal(m.popover(), undefined, "choosing closes it");
      m.indicator();
      m.clickRow("manual");
      assert.deepEqual(m.setRequests.at(-1), MANUAL);
      assert.equal(m.statuses.get("approval"), "approval: manual");

      // manual to jev lets the judge grant: the first choice only says so.
      m.indicator();
      m.clickRow("jev");
      assert.equal(m.popover().isArmed(), true);
      assert.equal(m.setRequests.length, 2, "nothing applied yet");
      assert(
        m.lines().some((line) => line.includes("jev may approve or deny this session's asks")),
        m.lines().join("\n"),
      );
      assert(m.lines().some((line) => line.includes("Choose jev again to turn it on")));
      m.clickRow("jev");
      assert.deepEqual(m.setRequests.at(-1), ROOT);
      m.indicator();
      m.clickRow("jev + sub");
      assert.equal(m.popover().isArmed(), true, "adding subagents widens too");
      assert(
        m.lines().some((line) => line.includes("jev may decide asks here and from subagents")),
        m.lines().join("\n"),
      );
      m.popover().handleInput("\u001b[B");
      assert.equal(m.popover().isArmed(), false, "moving away disarms");
      m.popover().handleInput("\u001b");
      assert.deepEqual(m.setRequests.at(-1), ROOT);
    } finally {
      await m.shutdown();
    }
  });

  test("yolo needs a second choice, reaches the authority's set, and is recorded in the session", async () => {
    const m = await mountApproval();
    try {
      m.indicator();
      m.clickRow("yolo");
      assert.equal(m.popover().isArmed(), true, "the first choice only arms");
      assert.equal(yoloSet().has("approval-root"), false);
      // Every semantics of the popover warning, per line, at the same strength
      // as before: Bash/Git scope with destructive writes, the Jev/checkpoint
      // bypass, and the still-holding denies/floor/static guard plus re-choice.
      // The dialog's full warning keeps the opaque-program fact.
      for (const warning of [
        "Bash/Git asks, destructive writes",
        "bypasses Jev and hard checkpoints",
        "denies, the floor",
        "static guard stay. Choose yolo again",
      ]) {
        assert(
          m.lines().some((line) => line.includes(warning)),
          m.lines().join("\n"),
        );
      }
      assert(m.lines().at(-1).startsWith("╰"), "the warning fits above the bottom edge");
      m.clickRow("yolo");
      assert.equal(
        yoloSet().has("approval-root"),
        true,
        "the managed authority now allows this session's asks",
      );
      assert.deepEqual(
        m.entries.at(-1),
        choiceEntry("approval-root", true, SUB),
        "the judge mode under yolo is recorded with it",
      );
      assert.equal(m.statuses.get("approval"), "approval: YOLO");
      assert.equal(m.notices.at(-1).level, "warning");
      assert.match(m.notices.at(-1).message, /in-process subagents/);
      assert.deepEqual(m.setRequests, [], "yolo leaves the judge's own mode alone");

      // Arming is for the row it was given on.
      m.indicator();
      m.popover().handleInput("\u001b[A");
      assert.equal(m.popover().isArmed(), false);
      // Any judge mode is narrower than yolo: one click turns it off and says so.
      m.clickRow("jev + sub");
      assert.equal(yoloSet().has("approval-root"), false);
      assert.deepEqual(m.entries.at(-1), choiceEntry("approval-root", false, SUB));
      assert.equal(m.statuses.get("approval"), "approval: jev+sub");
      assert.match(m.notices.at(-1).message, /yolo is off/);
    } finally {
      await m.shutdown();
    }
  });

  test("keyboard, × and permission dialogs all close the approval popover without applying", async () => {
    const m = await mountApproval();
    try {
      m.indicator();
      m.popover().handleInput("\u001b");
      assert.equal(m.popover(), undefined, "Esc closes");
      m.indicator();
      m.popover().handleInput("\u001b[A");
      m.popover().handleInput("\r");
      assert.deepEqual(m.setRequests.at(-1), ROOT, "↑ then Enter applies the (narrower) row above");
      m.indicator();
      const top = m.lines()[0];
      m.click(top.indexOf("×"), 0);
      assert.equal(m.popover(), undefined, "× closes");
      m.indicator();
      m.f.pi.events.emit("permissions:ui_prompt", { requestId: "r1" });
      assert.equal(m.popover(), undefined, "a permission dialog takes the keyboard back");
      assert.equal(m.setRequests.length, 1);
      m.indicator();
      assert.equal(m.indicator(), true);
      assert.equal(m.popover(), undefined, "a second indicator click toggles it closed");
    } finally {
      await m.shutdown();
    }
  });

  test("the approval popover joins the bottom-right column and steps aside for harness panels", async () => {
    const m = await mountApproval();
    try {
      const below = joinPopoverStack(m.tui);
      below.measure(6);
      m.indicator();
      const paint = () =>
        m.tui.compositeOverlays(
          Array(m.tui.terminal.rows).fill(""),
          m.tui.terminal.columns,
          m.tui.terminal.rows,
        );
      paint();
      paint();
      const entry = m.tui.overlayStack.find((candidate) => candidate.component === m.popover());
      assert.equal(
        entry.bounds.row + entry.bounds.height,
        m.tui.terminal.rows - FOOTER_HEIGHT - 6,
        "above what was already open",
      );
      assert.equal(entry.bounds.col + entry.bounds.width, m.tui.terminal.columns);
      assert.equal(entry.options.nonCapturing, false, "it takes the keyboard for ↑↓ Enter Esc");
      m.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
      assert.equal(m.popover(), undefined, "off the overlay stack while a harness panel closes");
      await nextTick();
      assert(m.popover(), "back on the next tick");
      // A column too short for every row plus a warning keeps it off screen,
      // rather than clipping the warning under a clickable armed row.
      below.measure(m.tui.terminal.rows - 1 - 9);
      paint();
      paint();
      assert.equal(
        m.tui.overlayStack.find((candidate) => candidate.component === m.popover())?.bounds,
        undefined,
      );
      below.leave();
    } finally {
      await m.shutdown();
    }
  });

  for (const judgeFirst of [false, true]) {
    test(`resuming restores the judge mode, never wider than the launch (judge loaded ${judgeFirst ? "first" : "second"})`, async () => {
      const m = await mountApproval({
        judgeFirst,
        branch: [choiceEntry("approval-root", false, MANUAL)],
      });
      try {
        assert.deepEqual(m.setRequests, [MANUAL], "a manual pick survives resume");
        assert.equal(m.statuses.get("approval"), "approval: manual");
        assert.deepEqual(m.entries, [], "a restored mode that matches the record writes nothing");
        await m.switchSession("approval-wide", [choiceEntry("approval-wide", false, SUB)]);
        assert.deepEqual(m.setRequests.at(-1), MANUAL, "(unchanged)");
        assert.equal(
          m.statuses.get("approval"),
          "approval: jev+sub",
          "a pick equal to the launch mode needs no request",
        );
      } finally {
        await m.shutdown();
      }
      const narrow = await mountApproval({
        judgeFirst,
        launch: MANUAL,
        branch: [choiceEntry("approval-root", false, SUB)],
      });
      try {
        assert.deepEqual(
          narrow.setRequests,
          [],
          "an explicit shadow launch wins over a wider recorded pick",
        );
        assert.equal(narrow.statuses.get("approval"), "approval: manual");
      } finally {
        await narrow.shutdown();
      }
      const between = await mountApproval({
        judgeFirst,
        launch: ROOT,
        branch: [choiceEntry("approval-root", false, SUB)],
      });
      try {
        assert.deepEqual(between.setRequests, [], "jev + sub recorded, jev launched: stays jev");
        assert.deepEqual(between.entries.at(-1), undefined);
      } finally {
        await between.shutdown();
      }
    });
  }

  test("resuming offers yolo back behind a confirmation instead of resuming it", async () => {
    const declined = await mountApproval({
      confirm: false,
      branch: [choiceEntry("approval-root", true, MANUAL)],
    });
    try {
      assert.equal(
        yoloSet().has("approval-root"),
        false,
        "declined: every ask still goes through review",
      );
      assert.equal(declined.dialogs.at(-1)?.title, "Resume yolo for this session?");
      assert.deepEqual(declined.setRequests, [MANUAL], "the judge mode under yolo is restored");
      assert.deepEqual(
        declined.entries.at(-1),
        choiceEntry("approval-root", false, MANUAL),
        "the answer is recorded, so it is not asked again",
      );
      assert.equal(
        declined.statuses.get("approval"),
        "approval: manual",
        "turning yolo down returns to the mode that was picked",
      );
    } finally {
      await declined.shutdown();
    }

    let answer;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    const accepted = await mountApproval({
      confirm: () => pending,
      branch: [choiceEntry("approval-root", true, SUB)],
    });
    try {
      assert.equal(yoloSet().has("approval-root"), false, "until it is answered, yolo is off");
      answer(true);
      await nextTick();
      assert.equal(yoloSet().has("approval-root"), true, "accepted: yolo resumes");
      assert.equal(accepted.statuses.get("approval"), "approval: YOLO");
      await accepted.switchSession("approval-other");
      assert.equal(
        yoloSet().has("approval-root"),
        false,
        "the previous session's grant does not outlive the switch",
      );
      assert.equal(
        yoloSet().has("approval-other"),
        false,
        "a new session starts from the launch default",
      );
    } finally {
      await accepted.shutdown();
    }
    assert.equal(yoloSet().size, 0, "shutdown leaves no grant behind");

    const headless = await mountApproval({ branch: [choiceEntry("approval-root", true)] });
    try {
      headless.ctx.hasUI = false;
      await headless.switchSession("approval-root", [choiceEntry("approval-root", true)]);
      assert.equal(
        yoloSet().has("approval-root"),
        false,
        "with nobody to confirm, yolo is not resumed",
      );
    } finally {
      await headless.shutdown();
    }
  });

  test("a fork, clone or foreign record restores nothing", async () => {
    const m = await mountApproval({ branch: [choiceEntry("approval-parent", true, MANUAL)] });
    try {
      assert.equal(m.dialogs.length, 0, "a record copied from another session id is not offered");
      assert.deepEqual(m.setRequests, [], "nor is its judge mode");
      assert.equal(m.statuses.get("approval"), "approval: jev+sub");
      await m.switchSession("approval-legacy", [
        { type: "custom", customType: APPROVAL_ENTRY, data: { yolo: true } },
      ]);
      assert.equal(m.dialogs.length, 0, "a record naming no session restores nothing");
    } finally {
      await m.shutdown();
    }
  });

  test("/tree keeps the live state and makes the new branch's record agree", async () => {
    const m = await mountApproval();
    try {
      // The first review's repro: on, then manual, then back to before the revocation.
      m.pick("yolo");
      m.pick("manual");
      assert.equal(m.history().length, 2);
      await m.navigate(1);
      assert.equal(yoloSet().has("approval-root"), false, "navigation does not turn yolo on");
      assert.equal(m.statuses.get("approval"), "approval: manual");
      assert.deepEqual(
        m.entries.at(-1),
        choiceEntry("approval-root", false, MANUAL),
        "the stale record is revoked at once",
      );
      await m.switchSession("approval-root", m.history());
      assert.equal(m.dialogs.length, 0, "reopening the session has no yolo to offer");

      // The other direction: live yolo, moved to before it was granted.
      m.pick("yolo");
      const before = m.history().length - 1;
      await m.navigate(before);
      assert.equal(
        yoloSet().has("approval-root"),
        true,
        "live yolo stays on and the indicator still says so",
      );
      assert.equal(m.statuses.get("approval"), "approval: YOLO");
      assert.equal(m.entries.at(-1).data.yolo, true);
      const recorded = m.history().length;
      await m.navigate(recorded);
      assert.equal(m.history().length, recorded, "a branch that already agrees gets no new record");
    } finally {
      await m.shutdown();
    }
  });

  test("a change made elsewhere is recorded; a failed record is said out loud and never fails open", async () => {
    const m = await mountApproval();
    try {
      // /auto-approval or another path changing the judge directly.
      Object.assign(m.judge, MANUAL);
      m.publish();
      assert.deepEqual(m.entries.at(-1), choiceEntry("approval-root", false, MANUAL));
      m.pick("yolo");
      assert.equal(m.entries.at(-1).data.yolo, true);
      // The second review's case: the revocation cannot be written.
      m.failing.append = true;
      m.pick("manual");
      assert.equal(
        yoloSet().has("approval-root"),
        false,
        "turning yolo off is live even when the record fails",
      );
      assert(
        m.notices.some(
          (notice) => notice.level === "warning" && /could not be recorded/.test(notice.message),
        ),
        JSON.stringify(m.notices),
      );
      m.failing.append = false;
      // The branch still says yolo; resuming only offers it back.
      await m.switchSession("approval-root", m.history());
      assert.equal(yoloSet().has("approval-root"), true, "(the fixture confirms by default)");
      assert.equal(
        m.dialogs.at(-1).title,
        "Resume yolo for this session?",
        "a stale record reaches nothing without a confirmation",
      );
    } finally {
      await m.shutdown();
    }
  });

  test("a confirmation answered after the session changed grants nothing to either session", async () => {
    // The third review's repro: /approval yolo waits, the session switches, the
    // old dialog then answers Yes, and the old session is resumed.
    for (const leave of ["switch", "shutdown"]) {
      let answer;
      const m = await mountApproval({
        confirm: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      const pending = m.commands.get("approval").handler("yolo", m.ctx);
      await nextTick();
      if (leave === "switch") await m.switchSession("approval-next");
      else await m.shutdown();
      answer(true);
      await pending;
      assert.equal(
        yoloSet().has("approval-root"),
        false,
        `${leave}: the old session is not granted`,
      );
      assert.equal(yoloSet().has("approval-next"), false, `${leave}: nor is the new one`);
      assert.equal(
        m.entries.some((entry) => entry.data?.yolo === true),
        false,
        `${leave}: nothing is recorded`,
      );
      if (leave === "switch") {
        await m.switchSession("approval-root", m.history());
        assert.equal(
          yoloSet().has("approval-root"),
          false,
          "resuming the old session finds no yolo",
        );
        assert.equal(m.statuses.get("approval"), "approval: jev+sub");
        await m.shutdown();
      }
    }
  });

  test("/approval takes a mode by name and confirms every widening; the regular renderer uses dialogs", async () => {
    const declined = await mountApproval({ confirm: false });
    try {
      const run = (args) => declined.commands.get("approval").handler(args, declined.ctx);
      await run("yolo");
      assert.equal(
        yoloSet().has("approval-root"),
        false,
        "a declined confirmation changes nothing",
      );
      await run("manual");
      assert.deepEqual(declined.setRequests.at(-1), MANUAL, "narrowing asks nothing");
      const dialogs = declined.dialogs.length;
      await run("jev");
      assert.equal(declined.dialogs.length, dialogs + 1, "widening to the judge asks");
      assert.match(declined.dialogs.at(-1).title, /Let jev approve/);
      assert.deepEqual(declined.setRequests.at(-1), MANUAL, "and a No keeps manual");
      await run("sometimes");
      assert.equal(declined.notices.at(-1).level, "error");
    } finally {
      await declined.shutdown();
    }
    const regular = await mountApproval({
      mode: "regular",
      select: (options) => options.find((option) => option.startsWith("yolo")),
    });
    try {
      assert.equal(regular.indicator(), true);
      await nextTick();
      assert.equal(regular.popover(), undefined, "no overlay on the regular renderer");
      assert.equal(
        yoloSet().has("approval-root"),
        true,
        "Pi's select and confirm dialogs stand in for the popover",
      );
    } finally {
      await regular.shutdown();
    }
    const unjudged = await mountApproval({ judges: false });
    try {
      unjudged.f.pi.events.emit("approval:judge-state", undefined);
      unjudged.indicator();
      assert.deepEqual(
        unjudged
          .lines()
          .slice(1, 3)
          .map((line) => line.slice(1).trim().split(/ {2,}/)[0]),
        ["› ● manual", "○ yolo"],
      );
    } finally {
      await unjudged.shutdown();
    }
  });
}
