// UI footer/usage/stack checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
export function createFooterTests(
  footerExtension,
  fixture,
  TuiAltScreen,
  visibleWidth,
  POPOVER,
  PresetPicker,
  joinPopoverStack,
  stackedOverlayOptions,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  FOOTER_INDICATOR_CLICK_EVENT,
  WORKER_PRESET_INDICATOR,
  ApprovalPopover,
  approvalChoices,
  SessionManager,
  AgentSession,
  approvalStatus,
  healthStatus,
  HEALTH_INDICATOR,
) {
  const MARKER = "\u0000pi-status-footer\u0000";
  const FOOTER_ROWS = 24;
  /** The footer occupies one row, which is what the overlay must clear. */
  const FOOTER_HEIGHT = 1;
  const FOOTER_COLUMNS = 300;

  function usage(input, output, cacheRead, cacheWrite, cost) {
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
  }

  /** Every payer the overlay listed, in the order it listed them. */
  const spendKeys = (lines) =>
    lines
      .slice(1, -1)
      .map((line) =>
        line
          .replace(/^\s*│ ?/, "")
          .split(/\s{2,}/)[0]
          .trim(),
      )
      .filter((key) => key && !/^[\u2500-\u257f]+$/.test(key));

  /** The × closes every popover from the right end of its top edge. */
  const CLOSE_TAIL = ` ${POPOVER.close} ${POPOVER.h}${POPOVER.tr}`;
  /** Visible column of the × on a painted top edge, ANSI or not. */
  const closeColumn = (top) => stripVTControlCharacters(top).indexOf(POPOVER.close);
  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Real footer and SDK overlay compositor; no terminal I/O or scheduled paints. */
  async function mountFooter({
    mode = "regular",
    entries = [],
    sessionManager,
    statuses = new Map(),
    theme,
    renderRoot = () => [],
  } = {}) {
    const f = fixture();
    const overlays = [];
    const inputHandlers = new Set();
    const originalRender = (width) => renderRoot(width, footer);
    const terminal = { rows: FOOTER_ROWS, columns: FOOTER_COLUMNS, hideCursor() {} };
    const compositor = new TuiAltScreen(terminal, false, undefined, {});
    compositor.requestRender = () => {};
    let unsubscribed = false;
    const tui = {
      mode,
      render: originalRender,
      requestRender() {},
      terminal,
      showOverlay(component, options) {
        const entry = { component, options, hidden: false, lines: [], handle: undefined };
        const handle = compositor.showOverlay(
          {
            ...component,
            render(width) {
              entry.lines = component.render(width);
              return entry.lines;
            },
          },
          options,
        );
        entry.handle = handle;
        overlays.push(entry);
        return {
          hide: () => {
            entry.hidden = true;
            handle.hide();
          },
          getBounds: () => handle.getBounds(),
        };
      },
    };
    theme ??= { fg: (_color, text) => text, bold: (text) => text };
    let footer;
    f.ctx.ui.setFooter = (factory) => {
      footer = factory(tui, theme, {
        getGitBranch: () => "main",
        getExtensionStatuses: () => statuses,
        onBranchChange: () => () => {
          unsubscribed = true;
        },
      });
    };
    f.ctx.ui.onTerminalInput = (handler) => {
      inputHandlers.add(handler);
      return () => inputHandlers.delete(handler);
    };
    f.ctx.sessionManager = sessionManager ?? { getEntries: () => entries };
    f.ctx.getContextUsage = () => ({ tokens: 100, contextWindow: 1000, percent: 10 });
    f.ctx.model = { id: "test-model", provider: "fixture", reasoning: true };
    f.ctx.thinkingLevel = "high";
    footerExtension(f.pi);
    await f.emit("session_start");
    const visible = () => overlays.filter((entry) => !entry.hidden);
    const paintOverlay = () => {
      const base = Array(terminal.rows).fill(" ".repeat(terminal.columns));
      base[terminal.rows - 1] = footer.render(terminal.columns)[0];
      // Exercise real width resolution, terminal clamping and bottom anchoring.
      return compositor.compositeOverlays(base, terminal.columns, terminal.rows);
    };
    return {
      f,
      footer,
      tui,
      overlays,
      visible,
      paintOverlay,
      bounds: () => visible().at(-1).handle.getBounds(),
      originalRender,
      line: (width = FOOTER_COLUMNS) => footer.render(width)[0],
      wasUnsubscribed: () => unsubscribed,
      inputHandlers,
      feed: (data) => {
        for (const handler of inputHandlers) handler(data);
      },
      // The footer is the last row; a pointer over it arrives with local coordinates.
      hover: (x = 0) =>
        footer.handleMouse({
          type: "move",
          button: "none",
          x,
          y: 0,
          screenX: x,
          screenY: terminal.rows - 1,
          width: terminal.columns,
          height: FOOTER_HEIGHT,
          shift: false,
          alt: false,
          ctrl: false,
        }),
      clickFooter: (x = 0) =>
        footer.handleMouse({
          type: "click",
          button: "left",
          x,
          y: 0,
          screenX: x,
          screenY: terminal.rows - 1,
          width: terminal.columns,
          height: FOOTER_HEIGHT,
          shift: false,
          alt: false,
          ctrl: false,
        }),
      clickOverlay: (x = 1, y = 1, button = "left") =>
        visible()
          .at(-1)
          .component.handleMouse({
            type: "click",
            button,
            x,
            y,
            screenX: x,
            screenY: y,
            width: visible().at(-1).options.width,
            height: 10,
            shift: false,
            alt: false,
            ctrl: false,
          }),
      overlayLines: (width) => {
        if (width !== undefined) return visible().at(-1).component.render(width);
        paintOverlay();
        return visible().at(-1).lines;
      },
    };
  }

  // Four payers in entry order, so the overlay has to do the cost ordering itself.
  const spendEntries = [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "fixture-strong-model",
        usage: usage(1000, 200, 5000, 100, 0.25),
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "auto",
        responseModel: "gpt-5.6-luna",
        usage: usage(10, 20, 0, 0, 0.01),
      },
    },
    { type: "message", message: { role: "toolResult", usage: usage(50, 60, 0, 0, 0.5) } },
    { type: "compaction", usage: usage(7, 8, 0, 0, 0.02) },
    // Output with no prompt at all: a hit rate of nothing is unknown, not zero.
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "ollama",
        model: "qwen3.8:27b",
        usage: usage(0, 500, 0, 0, 0),
      },
    },
  ];

  /** A tool result whose usage names the models behind it. `input`/`cost` here
   * are the flat figures Pi counts; the rows say how much of them was delegated,
   * and anything they leave over is the tool's own work. */
  const delegated = (flat, rows) => ({
    type: "message",
    message: { role: "toolResult", toolName: "bash", usage: { ...flat, harnessModels: rows } },
  });
  const workerRow = (model, input, cost) => ({
    model,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
  });
  function registerMain() {
    for (const mode of ["regular", "fullscreen"])
      test(`footer input parentheses show only the cache-hit rate (${mode})`, async () => {
        const entry = {
          type: "message",
          message: { role: "assistant", provider: "fixture", model: "cache-model" },
        };
        const mounted = await mountFooter({ mode, entries: [entry] });
        try {
          for (const [reported, expected] of [
            [usage(500, 20, 9000, 500, 0.25), "10k (90.0%)"],
            [usage(0, 20, 0, 1100000, 0.25), "1.1M (0.0%)"],
            [usage(0, 20, 0, 0, 0.25), "0 (?)"],
          ]) {
            entry.message.usage = reported;
            const line = mounted.line();
            assert(line.includes(`↑${expected} ↓20 $0.250`), line);
          }
        } finally {
          mounted.footer.dispose();
        }
      });

    test("footer hides subagent indicators but retains unrelated status and metrics", async () => {
      const mounted = await mountFooter({
        statuses: new Map([
          ["subagents", "HIDDEN_RUNNING"],
          ["other-extension", "OTHER_STATUS\n ready"],
        ]),
      });
      const { f, footer, tui, originalRender } = mounted;
      try {
        f.pi.events.emit("subagents:created", { id: "child" });
        const line = mounted.line();
        assert(!line.includes("HIDDEN"));
        assert(!line.includes("sub 1"));
        for (const expected of [
          "test-model",
          "(high)",
          "100/1.0k",
          "OTHER_STATUS ready",
          "(main)",
        ]) {
          assert(line.includes(expected), `Missing footer content: ${expected}`);
        }
        for (const width of [1, 20, 80, 300]) {
          assert(visibleWidth(footer.render(width)[0]) <= width);
        }
        assert.equal(
          f.listeners.get("subagents:created"),
          undefined,
          "footer does not track subagent activity",
        );
        assert.equal(f.listeners.get(HIDE_TRANSIENT_OVERLAYS_EVENT)?.size, 1);
      } finally {
        footer.dispose();
      }
      assert([...f.listeners.values()].every((listeners) => listeners.size === 0));
      assert(mounted.wasUnsubscribed());
      // The original function is restored via its bound wrapper.
      assert.deepEqual(tui.render(80), originalRender(80));
    });

    test("clicking the footer breaks tokens and cost down by model id without providers", async () => {
      const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
      const { footer } = mounted;
      try {
        assert.deepEqual(mounted.visible(), [], "no overlay before the click");
        mounted.clickFooter();
        assert.equal(mounted.visible().length, 1);
        const lines = mounted.overlayLines();
        const rows = lines.map((line) => line.trim());
        assert(rows[0].includes("usage by model"));
        // Ordered by cost, so the answer to "where did the money go" is the top row.
        // Every payer, in full: filtering to the expected set would let the overlay
        // grow a bogus row, or double one, without the gate noticing.
        assert.deepEqual(spendKeys(lines), [
          "model",
          "tools",
          "fixture-strong-model",
          "main · compact/summaries",
          "gpt-5.6-luna",
          "qwen3.8:27b",
          "total",
        ]);
        assert(!lines.some((line) => /openai-codex|ollama/.test(line)));
        assert(
          stripVTControlCharacters(lines[0]).endsWith(CLOSE_TAIL),
          "the × replaces the old Dismiss row",
        );
        assert(
          !lines[1].includes(" W "),
          "cache-write is already included in prompt tokens and need not be an all-zero column",
        );
        // `responseModel` is what answered; the `auto` alias never appears.
        assert(!lines.some((line) => /\bauto\b/.test(line)));
        const total = lines.find((line) => line.includes("total"));
        assert(total.includes("0.780"), total);
        // The row the pointer is on must agree with the total the overlay shows,
        // for the cache hit rate as much as for the money.
        assert(mounted.line().includes("$0.780"));
        assert(total.includes("81.1%"), total);
        assert(mounted.line().includes("81.1%"));
        // Per model, the rate is that model's own prompt, not the session's.
        const astra = lines.find((line) => line.includes("fixture-strong-model"));
        assert(astra.includes("82.0%"), astra);
        const local = lines.find((line) => line.includes("qwen3.8:27b"));
        assert(local.includes("?"), local);
        assert(
          lines.some((line) => line.includes("6.1k")),
          "cached prompt tokens are rolled up",
        );
        // A pinned panel is not a dialog: it must not take the keyboard, and it
        // must leave the footer row reachable for the next click.
        const options = mounted.visible().at(-1).options;
        assert.equal(options.nonCapturing, true, "a capturing overlay would steal the editor");
        assert.equal(options.anchor, "bottom-right");
        assert.equal(
          options.margin.bottom,
          FOOTER_HEIGHT,
          "a smaller margin would sit on the footer itself",
        );

        // An overlay wider than the terminal, or one row tall, must still be a box.
        for (const width of [1, 12, 20, 40, 80, 300]) {
          for (const line of mounted.overlayLines(width)) {
            assert(visibleWidth(line) <= width, `overlay line exceeds ${width}: ${line}`);
          }
        }
        // Clipping to a sliver is not the same as still being a box, so check the
        // frame at a width that has room for one.
        const framed = mounted.overlayLines(60);
        assert(
          framed[0].startsWith(POPOVER.tl + POPOVER.h) && framed[0].includes(POPOVER.tr),
          framed[0],
        );
        // Body rows and the rule that separates the total both carry their verticals.
        for (const line of framed.slice(1, -1)) {
          assert(line.startsWith(POPOVER.v) || line.startsWith(POPOVER.ml), line);
          assert(line.trimEnd().endsWith(POPOVER.v) || line.trimEnd().endsWith(POPOVER.mr), line);
        }
        assert(
          framed.at(-1).startsWith(POPOVER.bl) && framed.at(-1).endsWith(POPOVER.br),
          framed.at(-1),
        );
      } finally {
        footer.dispose();
      }
    });

    test("native SDK UsageEntries, including unknown kinds, match session totals without double billing", async (t) => {
      t.mock.method(globalThis, "fetch", () => {
        assert.fail("footer accounting must not call the network");
      });
      const manager = SessionManager.inMemory("/fixture/project");
      const first = manager.appendMessage({
        role: "user",
        content: "accounting fixture",
        timestamp: 0,
      });
      manager.appendMessage({
        role: "assistant",
        provider: "p",
        model: "alias",
        responseModel: "shared-model",
        api: "fixture",
        content: [],
        stopReason: "stop",
        timestamp: 1,
        usage: usage(100, 20, 30, 40, 1),
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "fixture",
        toolName: "bash",
        content: [],
        isError: false,
        timestamp: 2,
        usage: { ...usage(50, 6, 7, 8, 2), harnessModels: [workerRow("p/shared-model", 25, 1)] },
      });
      manager.appendCompaction(
        "fixture summary",
        first,
        100,
        undefined,
        false,
        usage(9, 10, 11, 12, 0.25),
      );
      manager.branchWithSummary(
        manager.getLeafId(),
        "fixture branch summary",
        undefined,
        false,
        usage(13, 14, 15, 16, 0.5),
      );
      manager.appendUsage("cache_warm", "p", "shared-model", usage(17, 18, 19, 20, 0.125));
      manager.appendUsage("cache_warm", "q", "shared-model", usage(21, 22, 23, 24, 0.75));
      manager.appendUsage("future-kind", "p", "warm-only", usage(0, 0, 5, 0, 0));
      const mounted = await mountFooter({ mode: "fullscreen", sessionManager: manager });
      try {
        mounted.clickFooter();
        mounted.overlayLines();
        // A new kind arrives while the popover stays open. It is ordinary spend,
        // not a reason to drop the entry or add a separate same-model row.
        manager.appendUsage("unknown-operation", "p", "shared-model", usage(1, 2, 3, 4, 0.0625));
        const before = structuredClone(manager.getEntries());
        const native = AgentSession.prototype.getSessionStats.call({
          sessionManager: manager,
          sessionId: manager.getSessionId(),
          getContextUsage: () => undefined,
        });
        assert.equal(native.cost, 4.6875);
        for (const [key, value] of Object.entries({
          input: 211,
          output: 92,
          cacheRead: 113,
          cacheWrite: 124,
        })) {
          assert.equal(native.tokens[key], value);
        }
        const prompt = native.tokens.input + native.tokens.cacheRead + native.tokens.cacheWrite;
        const line = mounted.line(),
          lines = mounted.overlayLines();
        // Cache reads and writes still count toward prompt totals and the hit-rate
        // denominator; only the hit rate is shown inside the footer parentheses.
        assert(line.includes(`↑${prompt} (25.2%)`), line);
        assert(line.includes(`↓${native.tokens.output}`), line);
        assert(line.includes(`$${native.cost.toFixed(3)}`), line);
        assert.deepEqual(spendKeys(lines), [
          "model",
          "shared-model",
          "tools",
          "main · compact/summaries",
          "shared-model",
          "warm-only",
          "total",
        ]);
        const cells = (line) =>
          line
            .replace(/^│\s*/, "")
            .replace(/\s*│$/, "")
            .split(/\s{2,}/);
        assert.deepEqual(
          lines.filter((line) => line.includes("shared-model")).map(cells),
          [
            ["shared-model", "259", "52", "20.1%", "40", "2.188"],
            ["shared-model", "68", "23", "33.8%", "22", "0.750"],
          ],
          "same provider/model merges assistant + worker + warming; other providers stay separate",
        );
        assert.deepEqual(cells(lines.find((line) => line.includes("total"))), [
          "total",
          "448",
          "113",
          "25.2%",
          "92",
          "4.688",
        ]);
        assert.equal(mounted.visible().length, 1);
        assert.deepEqual(
          manager.getEntries(),
          before,
          "footer only reads the SDK accounting source",
        );
      } finally {
        mounted.footer.dispose();
      }
    });

    test("the usage overlay uses the same popover chrome as the worker picker", async () => {
      const colors = [];
      const mounted = await mountFooter({
        mode: "fullscreen",
        entries: spendEntries,
        theme: {
          fg: (color, text) => {
            colors.push(color);
            return text;
          },
          bold: (text) => text,
        },
      });
      try {
        mounted.clickFooter();
        mounted.overlayLines(60);
        assert.ok(colors.includes("borderAccent"), "outer frame matches the picker");
        assert.ok(colors.includes("borderMuted"), "sides and dividers match the picker");
        assert.ok(colors.includes("accent"), "the title is accent like the picker label");
        assert.ok(!colors.includes("border"), "the old generic border color is not used");
        assert.equal(colors[0], "borderAccent");
      } finally {
        mounted.footer.dispose();
      }
    });

    test("footer and usage counts carry rounded thousands into millions", async () => {
      const entry = {
        type: "message",
        message: {
          role: "assistant",
          provider: "fixture",
          model: "boundary-model",
          usage: usage(999499, 0, 0, 0, 1),
        },
      };
      const mounted = await mountFooter({ mode: "fullscreen", entries: [entry] });
      try {
        mounted.clickFooter();
        for (const [tokens, expected] of [
          [1000, "1.0k"],
          [999499, "999k"],
          [999500, "1.0M"],
          [999949, "1.0M"],
          [999950, "1.0M"],
          [999999, "1.0M"],
          [1000000, "1.0M"],
        ]) {
          entry.message.usage = usage(tokens, 0, 0, 0, 1);
          mounted.f.ctx.getContextUsage = () => ({
            tokens,
            contextWindow: 2000000,
            percent: tokens / 20000,
          });
          assert(mounted.line().includes(`${expected}/2.0M`));
          const lines = mounted.overlayLines(60);
          assert(lines.some((line) => line.includes(expected)));
          assert(!lines.some((line) => line.includes("1000k")));
        }
      } finally {
        mounted.footer.dispose();
      }
    });

    test("the footer remains one physical row with long labels, paths and statuses", async () => {
      const breaks = /[\t\n\v\f\r\u0085\u2028\u2029]/;
      const mounted = await mountFooter({
        mode: "fullscreen",
        statuses: new Map([["other", "status\n\t\u2028".repeat(100)]]),
      });
      try {
        mounted.f.ctx.cwd = "/fixture/长路径\n".repeat(80);
        mounted.f.ctx.model.id = "long-model\r\u2029".repeat(80);
        for (const width of [1, 12, 20, 80, 120, 300, 4000]) {
          const lines = mounted.footer.render(width);
          assert.equal(lines.length, FOOTER_HEIGHT);
          assert.doesNotMatch(lines[0], breaks);
          assert(visibleWidth(lines[0]) <= width);
        }
      } finally {
        mounted.footer.dispose();
      }
    });

    test("footer model labels preserve the selected model id without providers", async () => {
      const mounted = await mountFooter();
      try {
        for (const id of [
          "gpt-5.6-sol",
          "fixture-strong-model",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
          "qwen3.8:27b",
          "org/custom-model",
        ]) {
          mounted.f.ctx.model = { id, provider: "hidden-provider", reasoning: true };
          assert(mounted.line().includes(`${id} (high)`));
          assert(!mounted.line().includes("hidden-provider"));
          assert.equal(mounted.f.ctx.model.id, id);
        }
      } finally {
        mounted.footer.dispose();
      }
    });

    test("hiding providers does not merge their spend or strip model namespaces", async () => {
      const entries = [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "p",
            model: "gpt-5.6-sol",
            usage: usage(100, 0, 0, 0, 1),
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "q",
            model: "gpt-5.6-sol",
            usage: usage(200, 0, 0, 0, 2),
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "router",
            model: "org/custom-model",
            usage: usage(300, 0, 0, 0, 3),
          },
        },
      ];
      const before = structuredClone(entries);
      const mounted = await mountFooter({ mode: "fullscreen", entries });
      try {
        mounted.clickFooter();
        const lines = mounted.overlayLines();
        assert.deepEqual(spendKeys(lines), [
          "model",
          "org/custom-model",
          "gpt-5.6-sol",
          "gpt-5.6-sol",
          "total",
        ]);
        const sol = lines.filter((line) => line.includes("gpt-5.6-sol"));
        assert(sol[0].includes("2.000"));
        assert(sol[1].includes("1.000"));
        assert(mounted.line().includes("$6.000"));
        assert.deepEqual(entries, before);
      } finally {
        mounted.footer.dispose();
      }
    });

    test("the pinned panel stays live and fits its × and chrome on empty and crowded screens", async () => {
      const entries = [];
      const mounted = await mountFooter({ mode: "fullscreen", entries });
      try {
        mounted.clickFooter();
        assert(mounted.overlayLines().some((line) => line.includes("no usage recorded")));
        assert(stripVTControlCharacters(mounted.overlayLines()[0]).endsWith(CLOSE_TAIL));
        for (let i = 0; i < 40; i++)
          entries.push({
            type: "message",
            message: {
              role: "assistant",
              provider: "hidden-provider",
              model: `model-${i}`,
              usage: usage(100, 0, 0, 0, 1),
            },
          });
        for (const rows of [12, 24, 50]) {
          mounted.tui.terminal.rows = rows;
          const lines = mounted.overlayLines();
          const bounds = mounted.bounds();
          assert.equal(
            bounds.row + bounds.height,
            rows - FOOTER_HEIGHT,
            "the SDK anchors above the single footer row",
          );
          assert.equal(bounds.col + bounds.width, mounted.tui.terminal.columns);
          assert.equal(
            bounds.height,
            lines.length,
            "all chrome fits above the footer, nothing is clipped",
          );
          assert(
            lines.some((line) => line.includes("40.000")),
            "the total includes hidden rows",
          );
          assert(stripVTControlCharacters(lines[0]).endsWith(CLOSE_TAIL));
          assert(lines.at(-1).startsWith(POPOVER.bl), "the frame still closes at the bottom");
          assert.equal(
            mounted.overlays.length,
            1,
            "usage updates and resizing do not remount the panel",
          );
        }
        const lines = mounted.overlayLines(60);
        mounted.clickOverlay(closeColumn(lines[0]), 0);
        assert.deepEqual(mounted.visible(), [], "× hit geometry follows the latest paint");
      } finally {
        mounted.footer.dispose();
      }
    });

    test("a pinned panel follows real SDK resize layout and widens for new model usage", async () => {
      const entries = [];
      const mounted = await mountFooter({ mode: "fullscreen", entries });
      try {
        mounted.tui.terminal.columns = 20;
        mounted.clickFooter();
        mounted.overlayLines();
        assert.equal(mounted.bounds().width, 20);
        mounted.tui.terminal.columns = 120;
        mounted.overlayLines();
        const emptyWidth = mounted.bounds().width;
        assert(emptyWidth > 20, "widening cannot retain the opening-click width");
        const model = "a-much-longer-model-identity-after-the-panel-opened";
        entries.push({
          type: "message",
          message: {
            role: "assistant",
            provider: "fixture",
            model,
            usage: usage(1000, 1, 0, 0, 1),
          },
        });
        let lines = mounted.overlayLines();
        const fullWidth = mounted.bounds().width;
        assert(
          fullWidth > emptyWidth,
          "new usage changes the panel's desired width without a reopen",
        );
        assert(lines.some((line) => line.includes(model)));
        for (const columns of [12, 20, 120, 300, 120]) {
          mounted.tui.terminal.columns = columns;
          const screen = mounted.paintOverlay();
          const bounds = mounted.bounds();
          assert.equal(bounds.width, Math.min(fullWidth, columns));
          assert.equal(bounds.col + bounds.width, columns);
          assert.equal(bounds.row + bounds.height, mounted.tui.terminal.rows - FOOTER_HEIGHT);
          assert.equal(
            screen.at(-1),
            mounted.footer.render(columns)[0],
            "the overlay never covers the footer",
          );
          assert.equal(
            mounted.overlays.length,
            1,
            "layout does not remount or lose the pinned state",
          );
        }
        lines = mounted.overlayLines();
        mounted.clickOverlay(closeColumn(lines[0]), 0);
        assert.deepEqual(mounted.visible(), [], "the × follows the last layout");
      } finally {
        mounted.footer.dispose();
      }
    });

    test("usage preferred width shares one fresh spend read across a three-popover native frame", async () => {
      const manager = SessionManager.inMemory("/fixture/project");
      let entryReads = 0,
        fullWalks = 0;
      const mounted = await mountFooter({
        mode: "fullscreen",
        sessionManager: {
          getSessionId: () => manager.getSessionId(),
          getLeafId: () => manager.getLeafId(),
          getEntryCount: () => manager.getEntryCount(),
          getEntry(id) {
            entryReads++;
            return manager.getEntry(id);
          },
          getEntries() {
            entryReads++;
            fullWalks++;
            return manager.getEntries();
          },
        },
      });
      const extra = [];
      const addPanel = (preferredWidth) => {
        const member = joinPopoverStack(mounted.tui);
        const component = {
          render(width) {
            const lines = Array(4).fill("p".repeat(width));
            member.measure(lines.length);
            return lines;
          },
          invalidate() {},
        };
        const options = stackedOverlayOptions(member, {
          width: preferredWidth,
          nonCapturing: true,
        });
        const handle = mounted.tui.showOverlay(component, options);
        extra.push({ member, component, options, handle });
      };
      try {
        mounted.clickFooter();
        const usagePanel = mounted.visible().at(-1);
        addPanel(30);
        addPanel(44);
        const panels = [{ component: usagePanel.component, options: usagePanel.options }, ...extra];
        // Pi renders the root footer before compositeOverlays. One public append
        // per frame forces fresh work; its single entry read serves footer totals,
        // all three width getters and their component renders. Unchanged frames
        // must not refresh merely because layout asks for the preferred width.
        assert.equal(
          fullWalks,
          1,
          "the first layout initializes accounting with one full-session walk",
        );
        entryReads = 0;
        for (let frame = 0; frame < 4; frame++) {
          manager.appendCustomEntry("ui-frame-fixture", { frame });
          const before = entryReads;
          mounted.paintOverlay();
          assert.equal(
            entryReads,
            before + 1,
            "one fresh entry read per changed native frame, not per panel getter",
          );
          mounted.paintOverlay();
          assert.equal(entryReads, before + 1, "an unchanged native frame shares the cached spend");
          assert.equal(fullWalks, 1, "new entries are incremental, never historical rescans");
        }
        const initialWidth = mounted.bounds().width;

        // Streaming has no finalized usage entry, so direct width/paint probes do
        // not walk the transcript again between frames.
        const beforeStreaming = entryReads;
        for (let update = 0; update < 8; update++) {
          await mounted.f.emit("message_update", {
            assistantMessageEvent: { type: "text_delta", delta: "live" },
          });
          for (const panel of panels) {
            void panel.options.width;
            void panel.options.maxHeight;
            panel.component.render(panel.options.width);
          }
        }
        assert.equal(
          entryReads,
          beforeStreaming,
          "streaming probes reuse the current frame snapshot",
        );

        const longModel = "model-added-after-the-last-frame-".repeat(3);
        const message = {
          role: "assistant",
          provider: "fixture",
          api: "openai-responses",
          model: longModel,
          content: [],
          stopReason: "stop",
          timestamp: 1,
          usage: usage(10, 1, 0, 0, 1),
        };
        manager.appendMessage(message);
        await mounted.f.emit("message_end", { message });
        const beforeFirstWidth = entryReads;
        const grownWidth = usagePanel.options.width;
        assert.equal(
          entryReads,
          beforeFirstWidth + 1,
          "a width getter first after finalization refreshes the snapshot",
        );
        assert(grownWidth > initialWidth, "new finalized usage widens before the panel paints");
        assert(
          usagePanel.component.render(grownWidth).length > 0,
          "the already fresh width paints immediately",
        );
        assert.equal(
          entryReads,
          beforeFirstWidth + 1,
          "the first paint shares the width getter's work",
        );

        assert.equal(fullWalks, 1, "finalized usage also avoids another full-session walk");
        assert(mounted.line().includes("$1.000"));
        manager.resetLeaf();
        await mounted.f.emit("session_tree");
        assert.equal(
          usagePanel.options.width,
          grownWidth,
          "tree navigation keeps abandoned-branch spend and its model row",
        );
        assert.equal(
          entryReads,
          beforeFirstWidth + 1,
          "tree navigation does not reread unchanged session spend",
        );
        assert(
          mounted.line().includes("$1.000"),
          "the all-session total cannot regress with the active branch",
        );
        mounted.tui.terminal.columns = 20;
        mounted.paintOverlay();
        assert.equal(mounted.bounds().width, 20, "resize still clamps the shared live width");
      } finally {
        for (const panel of extra.reverse()) {
          panel.handle.hide();
          panel.member.leave();
        }
        mounted.footer.dispose();
      }
    });

    test("a worker's spend is billed to the model that ran it, not to a tools lump", async () => {
      const mounted = await mountFooter({
        mode: "fullscreen",
        entries: [
          {
            type: "message",
            message: {
              role: "assistant",
              provider: "openai-codex",
              model: "fixture-strong-model",
              usage: usage(100, 0, 0, 0, 0.5),
            },
          },
          delegated(usage(300, 0, 0, 0, 3), [
            workerRow("openai-codex/gpt-5.6-sol", 180, 2),
            // Same model as the parent: "by model" means one row, not two.
            workerRow("openai-codex/fixture-strong-model", 100, 0.75),
          ]),
        ],
      });
      const { footer } = mounted;
      try {
        mounted.clickFooter();
        const lines = mounted.overlayLines(60);
        const sol = lines.find((line) => line.includes("gpt-5.6-sol"));
        assert(sol && sol.includes("2.000"), `worker row missing its own cost: ${sol}`);
        const astra = lines.find((line) => line.includes("fixture-strong-model"));
        assert(astra.includes("1.250"), `parent and worker on one model share a row: ${astra}`);
        // 300 - 180 - 100 input and 3 - 2 - 0.75 cost were nobody's worker: the
        // tool's own, which still has to be shown or the rows stop adding up.
        const tools = lines.find((line) => /│ ?tools/.test(line));
        assert(tools && tools.includes("0.250"), `unclaimed remainder lost: ${tools}`);
        const total = lines.find((line) => line.includes("total"));
        assert(total.includes("3.500"), total);
        assert(mounted.line().includes("$3.500"), "the line the pointer is on still agrees");
      } finally {
        footer.dispose();
      }
    });

    test("main and worker compaction rows name their different sources", async () => {
      const mounted = await mountFooter({
        mode: "fullscreen",
        entries: [
          { type: "compaction", usage: usage(100, 20, 0, 0, 0.2) },
          delegated(usage(200, 0, 0, 0, 0.3), [
            workerRow("compaction/openai-codex/gpt-5.6-sol", 200, 0.3),
          ]),
        ],
      });
      try {
        mounted.clickFooter();
        const lines = mounted.overlayLines();
        assert.deepEqual(spendKeys(lines), [
          "model",
          "worker compact · gpt-5.6-sol",
          "main · compact/summaries",
          "total",
        ]);
      } finally {
        mounted.footer.dispose();
      }
    });

    test("a split that is not a real division of the usage is ignored, not believed", async () => {
      // Session entries are data. Each of these claims more than the tool reported,
      // or is not a spend row at all; every one must fall back to the lump.
      const bogus = [
        [workerRow("openai-codex/gpt-5.6-sol", 400, 1)],
        [workerRow("openai-codex/gpt-5.6-sol", 10, 9)],
        [workerRow("", 10, 1)],
        [workerRow("openai-codex/gpt-5.6-sol", -10, 1)],
        [workerRow("openai-codex/gpt-5.6-sol", 10, Number.NaN)],
        [{ model: "openai-codex/gpt-5.6-sol", input: 10 }],
        [null],
        ["openai-codex/gpt-5.6-sol"],
      ];
      for (const rows of bogus) {
        const mounted = await mountFooter({
          mode: "fullscreen",
          entries: [delegated(usage(300, 0, 0, 0, 3), rows)],
        });
        try {
          mounted.clickFooter();
          const lines = mounted.overlayLines(60);
          assert(
            !lines.some((line) => line.includes("gpt-5.6-sol")),
            `believed a bad split: ${JSON.stringify(rows)}`,
          );
          const tools = lines.find((line) => /│ ?tools/.test(line));
          assert(tools && tools.includes("3.000"), `lump lost the spend: ${tools}`);
          assert(mounted.line().includes("$3.000"));
        } finally {
          mounted.footer.dispose();
        }
      }
    });

    /**
     * Session entries are data on disk, written by whatever Pi version or extension
     * was running at the time, and `collectSpend` runs inside `footer.render` on
     * every frame. One entry missing a field must cost that entry, not the display.
     */
    test("a malformed session entry costs its own figures, never the frame", async () => {
      const malformed = [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "p",
            model: "m",
            usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
          },
        },
        { type: "message", message: { role: "toolResult", usage: { input: 5, cost: null } } },
        {
          type: "message",
          message: { role: "toolResult", usage: { input: 7, cost: { total: "free" } } },
        },
        {
          type: "compaction",
          usage: {
            input: Number.NaN,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.01 },
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "p",
            model: "n",
            usage: usage(10, 2, 0, 0, 0.25),
          },
        },
      ];
      const mounted = await mountFooter({ mode: "fullscreen", entries: malformed });
      try {
        const line = mounted.line();
        assert.ok(!/NaN|undefined/.test(line), `the footer line printed a non-figure: ${line}`);
        assert.ok(line.includes("$0.260"), `what WAS reported still adds up: ${line}`);
        mounted.clickFooter();
        const lines = mounted.overlayLines(60);
        for (const row of lines) assert.ok(!/NaN|undefined/.test(row), row);
        assert.ok(
          lines.some((row) => row.includes("0.250")),
          lines.join("\n"),
        );
      } finally {
        mounted.footer.dispose();
      }
    });

    /** A claim cannot be checked against a figure that is not one, so an entry
     * missing a component must not wave the whole split through. */
    test("a split riding on a malformed entry is refused like any other bad claim", async () => {
      const mounted = await mountFooter({
        mode: "fullscreen",
        entries: [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "bash",
              usage: {
                input: 300,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                harnessModels: [workerRow("openai-codex/gpt-5.6-sol", 180, 2)],
              },
            },
          },
        ],
      });
      try {
        mounted.clickFooter();
        const lines = mounted.overlayLines(60);
        assert.ok(!lines.some((row) => row.includes("gpt-5.6-sol")), lines.join("\n"));
        for (const row of lines) assert.ok(!/NaN/.test(row), row);
      } finally {
        mounted.footer.dispose();
      }
    });

    test("the breakdown is click-to-pin, with only the footer and its × toggling it closed", async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
      const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
      const { footer } = mounted;
      try {
        mounted.hover();
        assert.deepEqual(mounted.visible(), [], "hover never opens the panel");
        mounted.clickFooter();
        assert.equal(mounted.visible().length, 1);
        for (let column = 1; column < 6; column++) mounted.hover(column);
        for (const data of ["a", "\u001b[200~paste\u001b[201~", "\u001b", "\u001b[5~"])
          mounted.feed(data);
        mounted.clickOverlay();
        assert.equal(
          mounted.visible().length,
          1,
          "motion, typing, paste, Esc and table clicks leave it pinned",
        );
        assert.equal(mounted.inputHandlers.size, 0, "no keyboard interception is needed");
        mounted.clickFooter();
        assert.deepEqual(mounted.visible(), [], "the second footer click dismisses it");
        t.mock.timers.tick(5000);
        mounted.hover();
        assert.deepEqual(mounted.visible(), [], "hover cannot undo a dismissal, even later");

        mounted.clickFooter();
        for (const width of [60, 20]) {
          const lines = mounted.overlayLines(width);
          const x = closeColumn(lines[0]);
          assert.equal(x, width - 4, "the × sits at the right end of the top edge");
          mounted.clickOverlay(width - 6, 0);
          mounted.clickOverlay(x, 1);
          mounted.clickOverlay(x, 0, "right");
          assert.equal(mounted.visible().length, 1, "only a left click on the × tail closes");
          mounted.clickOverlay(width - 1, 0);
          assert.deepEqual(mounted.visible(), [], "the whole ` × ─╮` tail is the target");
          mounted.hover();
          assert.deepEqual(mounted.visible(), []);
          mounted.clickFooter();
        }
      } finally {
        footer.dispose();
      }
      assert.deepEqual(mounted.visible(), [], "dispose takes the overlay down");
      assert.equal(mounted.inputHandlers.size, 0);
    });

    test("the pinned panel steps aside while a harness panel closes, then returns to its place", async () => {
      const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
      try {
        mounted.clickFooter();
        mounted.paintOverlay();
        const place = mounted.bounds();
        mounted.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
        assert.deepEqual(
          mounted.visible(),
          [],
          "cooperatively steps aside during harness settlement",
        );
        // Keep the member's ordinal/width, not a ghost reservation of hidden rows.
        const above = joinPopoverStack(mounted.tui);
        try {
          assert.equal(
            above.bottom,
            FOOTER_HEIGHT,
            "hidden pinned content releases measured height",
          );
          above.measure(2);
          await nextTick();
          assert.equal(mounted.visible().length, 1, "back once the harness close has run");
          mounted.paintOverlay();
          assert.deepEqual(mounted.bounds(), place);
          assert.equal(
            above.bottom,
            FOOTER_HEIGHT + place.height,
            "the restored pinned member is still below the member that joined during yield",
          );
        } finally {
          above.leave();
        }
        mounted.clickFooter();
        assert.deepEqual(mounted.visible(), [], "a returned panel still toggles closed");

        mounted.clickFooter();
        mounted.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
        mounted.clickFooter();
        await nextTick();
        assert.deepEqual(mounted.visible(), [], "closing while stepped aside cancels the return");
        mounted.clickFooter();
        mounted.f.pi.events.emit(HIDE_TRANSIENT_OVERLAYS_EVENT, {});
        mounted.footer.dispose();
        await nextTick();
        assert.deepEqual(mounted.visible(), [], "teardown cancels the return");
      } finally {
        mounted.footer.dispose();
      }
    });

    test("the usage panel and a harness popover share one bottom-right column", async () => {
      const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
      const { tui } = mounted;
      try {
        mounted.clickFooter();
        // A harness popover joining from its own bundle, exactly as the picker does.
        const member = joinPopoverStack(tui);
        const picker = {
          render: (width) => {
            const lines = Array(8).fill("p".repeat(width));
            member.measure(8);
            return lines;
          },
          invalidate() {},
        };
        const handle = tui.showOverlay(picker, stackedOverlayOptions(member, { width: 50 }));
        mounted.paintOverlay();
        mounted.paintOverlay();
        const [usagePanel, harness] = mounted.visible().map((entry) => entry.handle.getBounds());
        assert.equal(
          usagePanel.row + usagePanel.height,
          tui.terminal.rows - FOOTER_HEIGHT,
          "the older panel keeps the footer",
        );
        assert.equal(
          harness.row + harness.height,
          usagePanel.row,
          "the newer popover rests directly on it",
        );
        for (const bounds of [usagePanel, harness])
          assert.equal(bounds.col + bounds.width, tui.terminal.columns);
        assert.equal(
          usagePanel.width,
          harness.width,
          "both independently bundled panels use the column width",
        );
        assert.equal(usagePanel.col, harness.col);

        // Closing the lower one drops the upper one onto the footer.
        mounted.clickFooter();
        mounted.paintOverlay();
        const dropped = handle.getBounds();
        assert.equal(dropped.row + dropped.height, tui.terminal.rows - FOOTER_HEIGHT);
        // Reopened, the usage panel queues above the popover already there.
        mounted.clickFooter();
        mounted.paintOverlay();
        mounted.paintOverlay();
        const reopened = mounted.visible().at(-1).handle.getBounds();
        assert.equal(reopened.row + reopened.height, dropped.row);
        handle.hide();
        member.leave();
      } finally {
        mounted.footer.dispose();
      }
    });

    for (const order of [
      ["usage", "approval", "routing"],
      ["usage", "routing", "approval"],
      ["approval", "usage", "routing"],
      ["approval", "routing", "usage"],
      ["routing", "usage", "approval"],
      ["routing", "approval", "usage"],
    ])
      test(`real popovers form a width-aligned upward column: ${order.join(" → ")}`, async () => {
        const entries = [...spendEntries];
        const mounted = await mountFooter({ mode: "fullscreen", entries });
        const { tui } = mounted;
        tui.terminal.rows = 50;
        const theme = {
          fg: (_color, text) => text,
          bg: (_color, text) => text,
          bold: (text) => text,
        };
        const panels = [];
        const paint = () => {
          for (let pass = 0; pass < 3; pass++) mounted.paintOverlay();
        };
        const check = () => {
          paint();
          const bounds = panels.map((panel) => panel.bounds());
          let bottom = tui.terminal.rows - FOOTER_HEIGHT;
          for (const box of bounds) {
            assert(box, "every open panel fits on screen");
            assert.equal(
              box.row + box.height,
              bottom,
              "stack directly upward, never overlap or leave a gap",
            );
            assert.equal(box.col + box.width, tui.terminal.columns);
            assert.equal(box.width, bounds[0].width);
            assert.equal(box.col, bounds[0].col, "both edges aligned");
            bottom = box.row;
          }
          for (const entry of mounted.visible()) {
            const width = entry.handle.getBounds().width;
            assert(
              entry.lines.every((line) => visibleWidth(line) === width),
              "every painted border/body fills the common width",
            );
            assert(
              entry.lines[0].endsWith(CLOSE_TAIL),
              "the close control stays at the right edge",
            );
            assert.match(entry.lines.at(-1), /^╰─+╯$/);
          }
        };
        try {
          for (const kind of order) {
            if (kind === "usage") {
              mounted.clickFooter();
              const entry = mounted.visible().at(-1);
              panels.push({
                bounds: () => entry.handle.getBounds(),
                close: () => mounted.clickFooter(),
              });
            } else {
              const member = joinPopoverStack(tui);
              let handle;
              const close = () => {
                handle.hide();
                member.leave();
              };
              const component =
                kind === "approval"
                  ? new ApprovalPopover({
                      theme,
                      choices: () => approvalChoices("jev"),
                      current: () => "manual",
                      warning: () => undefined,
                      choose() {},
                      close,
                      requestRender() {},
                      onRender: (height) => member.measure(height),
                    })
                  : new PresetPicker({
                      tui,
                      theme,
                      keybindings: { matches: () => false },
                      activeName: "fixture",
                      pointer: true,
                      presets: [
                        {
                          name: "fixture",
                          version: "starter-v3",
                          models: Object.fromEntries(
                            ["d1", "d2", "d3", "d4", "d5"].map((slot) => [slot, `fixture/${slot}`]),
                          ),
                        },
                      ],
                      done: close,
                      rows: () => member.available(),
                      onRender: (height) => member.measure(height),
                    });
              handle = tui.showOverlay(
                component,
                stackedOverlayOptions(member, { width: kind === "approval" ? 60 : 76 }),
              );
              panels.push({ bounds: () => handle.getBounds(), close });
            }
            check();
          }
          for (const columns of [120, 38, 200]) {
            tui.terminal.columns = columns;
            check();
          }
          const before = panels[0].bounds().width;
          entries.push({
            type: "message",
            message: {
              role: "assistant",
              provider: "fixture",
              model: "long-model-name-".repeat(7),
              usage: usage(1, 1, 0, 0, 1),
            },
          });
          check();
          assert(
            panels[0].bounds().width > before,
            "new usage widens the entire column without reopening",
          );
          panels.splice(1, 1)[0].close();
          check();
          panels.shift().close();
          check();
        } finally {
          for (const panel of panels.reverse()) panel.close();
          mounted.footer.dispose();
        }
      });

    test("the worker indicator sits in the corner and hands its clicks to the harness", async () => {
      const statuses = new Map([
        [WORKER_PRESET_INDICATOR, "delegation: lead/fixture-balanced"],
        ["other-extension", "OTHER"],
      ]);
      const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries, statuses });
      const claimed = [];
      let claim = true;
      const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => {
        claimed.push(click.key);
        if (claim && click.key === WORKER_PRESET_INDICATOR) click.handled = true;
      });
      try {
        for (const columns of [300, 120]) {
          mounted.tui.terminal.columns = columns;
          const line = mounted.line(columns);
          assert(line.endsWith("lead/fixture-balanced"), `pinned to the far right: ${line}`);
          assert(
            !line.includes("delegation:"),
            "the dock shows the mode and preset without its label",
          );
          assert(
            line.indexOf("OTHER") < line.indexOf("fixture-balanced"),
            "after every other status",
          );
          claimed.length = 0;
          mounted.clickFooter(columns - 1);
          mounted.clickFooter(line.indexOf("fixture-balanced"));
          assert.deepEqual(claimed, [WORKER_PRESET_INDICATOR, WORKER_PRESET_INDICATOR]);
          assert.deepEqual(mounted.visible(), [], "a claimed click does not open the usage panel");
        }
        const line = mounted.line();
        mounted.clickFooter(line.indexOf("OTHER"));
        assert.deepEqual(claimed.at(-1), "other-extension", "every status is offered its click");
        assert.equal(
          mounted.visible().length,
          1,
          "an unclaimed click falls back to the usage panel",
        );
        mounted.clickFooter(line.indexOf("$"));
        assert.deepEqual(mounted.visible(), [], "the usage figures still toggle it");
        const before = claimed.length;
        mounted.clickFooter(0);
        assert.equal(claimed.length, before, "the left side is nobody's indicator");
        assert.equal(mounted.visible().length, 1);
        mounted.clickFooter(0);
        claim = false;
        mounted.clickFooter(mounted.line().length - 1);
        assert.equal(
          mounted.visible().length,
          1,
          "with no harness to claim it, the corner still opens usage",
        );
        // Narrowing shortens the worker control rather than clipping it; its last
        // drawn cell still belongs to the indicator, not an off-screen hit region.
        const narrow = 40;
        const cut = stripVTControlCharacters(mounted.line(narrow));
        assert(/ · lead\/\S*…$/.test(cut), cut);
        claimed.length = 0;
        mounted.clickFooter(narrow - 1);
        assert.deepEqual(claimed, [WORKER_PRESET_INDICATOR]);
      } finally {
        off();
        mounted.footer.dispose();
      }
    });

    test("× hit-testing uses visual columns even when the theme adds ANSI escapes", async () => {
      const theme = {
        fg: (_color, text) => `\x1b[33m${text}\x1b[0m`,
        bold: (text) => `\x1b[1m${text}\x1b[0m`,
      };
      const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries, theme });
      try {
        for (const columns of [60, 13]) {
          mounted.tui.terminal.columns = columns;
          mounted.clickFooter();
          const lines = mounted.overlayLines();
          const x = closeColumn(lines[0]);
          assert.equal(x, mounted.bounds().width - 4, "ANSI does not shift the control");
          assert(lines[0].indexOf(POPOVER.close) > x, "string offsets differ from visible columns");
          mounted.clickOverlay(x - 2, 0);
          assert.equal(mounted.visible().length, 1);
          mounted.clickOverlay(x, 0);
          assert.deepEqual(mounted.visible(), []);
        }
      } finally {
        mounted.footer.dispose();
      }
    });

    test("a narrow usage panel omits the × instead of painting a non-clickable fragment", async () => {
      const mounted = await mountFooter({ mode: "fullscreen", entries: spendEntries });
      try {
        mounted.clickFooter();
        const wide = mounted.overlayLines(60);
        const x = closeColumn(wide[0]);
        assert(x >= 0);
        for (const width of [8, 4, 1]) {
          const lines = mounted.overlayLines(width);
          assert(
            !lines.some((line) => stripVTControlCharacters(line).includes(POPOVER.close)),
            `partial control at width ${width}`,
          );
          for (const line of lines) assert(visibleWidth(line) <= width);
          mounted.clickOverlay(x, 0);
          mounted.clickOverlay(width - 1, 0);
          assert.equal(
            mounted.visible().length,
            1,
            "the old hit was cleared by the narrower paint",
          );
        }
        mounted.clickFooter();
        assert.deepEqual(
          mounted.visible(),
          [],
          "the footer still closes a panel too narrow for the ×",
        );
        mounted.clickFooter();
        const fits = mounted.overlayLines(9);
        assert(
          stripVTControlCharacters(fits[0]).endsWith(CLOSE_TAIL),
          "the control fits at exactly 9 columns",
        );
        mounted.clickOverlay(closeColumn(fits[0]), 0);
        assert.deepEqual(mounted.visible(), []);
      } finally {
        mounted.footer.dispose();
      }
    });

    test("the renderer consumes mouse and focus reports before extension listeners", () => {
      let onInput;
      const terminal = {
        start(handler) {
          onInput = handler;
        },
        stop() {},
        async drainInput() {},
        write() {},
        get columns() {
          return 80;
        },
        get rows() {
          return 24;
        },
        get kittyProtocolActive() {
          return false;
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        on() {},
        off() {},
      };
      const tui = new TuiAltScreen(terminal, false, undefined, {});
      tui.start();
      const seen = [];
      try {
        // Exactly how the footer shows its breakdown, so the check covers the
        // overlay being up rather than only a bare renderer.
        tui.showOverlay(
          { render: (width) => ["x".repeat(width)], invalidate() {} },
          { anchor: "bottom-right", width: 20, nonCapturing: true },
        );
        tui.addInputListener((data) => {
          seen.push(data);
          return undefined;
        });
        onInput("\u001b[<35;10;24M"); // pointer move
        onInput("\u001b[<0;10;24M"); // press
        onInput("\u001b[O"); // focus out
        onInput("a"); // keystroke
        onInput("\u001b[200~x\u001b[201~"); // paste
      } finally {
        tui.stop();
      }
      assert.deepEqual(seen, ["a", "\u001b[200~x\u001b[201~"]);
    });

    test("breakdown is fullscreen-only and bottom padding uses this render's footer row without markers or shared-array mutation", async () => {
      let shared,
        renderRoot = (width, footer) => (shared = Object.freeze(["body", footer.render(width)[0]]));
      const regular = await mountFooter({
        entries: spendEntries,
        renderRoot: (width, footer) => renderRoot(width, footer),
      });
      try {
        // Mouse reports never reach a regular-mode footer, but a host that sent one
        // must not get an overlay composited into the lines backing scrollback.
        regular.hover();
        regular.clickFooter();
        assert.deepEqual(regular.visible(), []);
        assert(
          !regular.footer.render(80)[0].includes(MARKER),
          "regular rows never emit an in-band padding marker",
        );
        regular.tui.terminal.rows = 6;
        const padded = regular.tui.render(80);
        assert.deepEqual(padded, ["body", ...Array(4).fill(" ".repeat(80)), shared[1]]);
        assert.equal(shared.length, 2, "the frozen host buffer is not padded in place");
        assert.notEqual(padded, shared);
        const oldPaint = Object.freeze([regular.footer.render(80)[0]]);
        renderRoot = () => oldPaint;
        assert.equal(
          regular.tui.render(80),
          oldPaint,
          "a cached row without a same-render footer call cannot authorize padding",
        );
        renderRoot = (width, footer) => (shared = Object.freeze([footer.render(width)[0], "tail"]));
        assert.equal(regular.tui.render(80), shared, "a non-last footer is not padded or copied");
        renderRoot = () => (shared = Object.freeze([`literal${MARKER}${MARKER}`, "tail"]));
        assert.equal(
          regular.tui.render(80),
          shared,
          "retired marker spellings are ordinary content, never a scan trigger",
        );
        let indexedReads = 0;
        renderRoot = (width, footer) => {
          shared = new Proxy(
            Object.freeze([...Array(10000).fill("history"), footer.render(width)[0]]),
            {
              get(target, key, receiver) {
                if (typeof key === "string" && /^\d+$/.test(key)) indexedReads++;
                return Reflect.get(target, key, receiver);
              },
            },
          );
          return shared;
        };
        assert.equal(
          regular.tui.render(80),
          shared,
          "long history needs neither padding nor a transcript-sized copy",
        );
        assert.equal(indexedReads, 1, "only the last history row is inspected");
        let nested = false,
          inner;
        renderRoot = (width, footer) => {
          const row = footer.render(width)[0];
          if (!nested) {
            nested = true;
            try {
              inner = regular.tui.render(width);
            } finally {
              nested = false;
            }
          }
          return Object.freeze([nested ? "inner" : "outer", row]);
        };
        const outer = regular.tui.render(80);
        assert.equal(inner.length, 6);
        assert.equal(inner[0], "inner");
        assert.equal(outer.length, 6);
        assert.equal(outer[0], "outer", "nested renders restore the outer row observation");
        renderRoot = (width, footer) => {
          footer.render(width);
          throw new Error("synthetic-render");
        };
        assert.throws(() => regular.tui.render(80), /synthetic-render/);
        renderRoot = () => oldPaint;
        assert.equal(
          regular.tui.render(80),
          oldPaint,
          "throwing renders restore the token in finally",
        );
      } finally {
        regular.footer.dispose();
      }
      const full = await mountFooter({
        mode: "fullscreen",
        entries: spendEntries,
        renderRoot: (width, footer) => (shared = Object.freeze(["body", footer.render(width)[0]])),
      });
      try {
        assert(!full.footer.render(80)[0].includes(MARKER));
        assert.equal(
          full.tui.render(80),
          shared,
          "fullscreen uses its native dock and never pads or copies the root buffer",
        );
        full.clickFooter();
        assert.equal(
          full.visible().length,
          1,
          "the usage breakdown remains available in fullscreen",
        );
      } finally {
        full.footer.dispose();
      }
    });
  }
  function registerCorner() {
    test("approval sits to the right of worker routing in the footer's corner", async () => {
      const statuses = new Map([
        ["harness-preset", "workers: fixture-balanced"],
        ["approval", "approval: jev+sub"],
        ["other-extension", "OTHER"],
      ]);
      const mounted = await mountFooter({ mode: "fullscreen", statuses });
      const claimed = [];
      const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => {
        claimed.push(click.key);
        click.handled = true;
      });
      try {
        const line = mounted.line();
        assert(line.endsWith("OTHER · fixture-balanced · jev+sub"), line);
        mounted.clickFooter(line.indexOf("jev+sub"));
        assert.deepEqual(claimed, ["approval"]);
      } finally {
        off();
        mounted.footer.dispose();
      }
    });

    test("compact corner indicators preserve styled values and route clicks by their unchanged keys", async () => {
      const themed = {
        fg: (color, text) => (color === "error" ? `\x1b[31m${text}\x1b[39m` : text),
        bold: (text) => `\x1b[1m${text}\x1b[22m`,
      };
      const yolo = approvalStatus(themed, undefined, true);
      const statuses = new Map([
        [WORKER_PRESET_INDICATOR, "workers: fixture-strong"],
        ["approval", yolo],
        ["other-extension", "workers: unrelated"],
      ]);
      const mounted = await mountFooter({ mode: "fullscreen", statuses });
      const claimed = [];
      const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => {
        claimed.push(click.key);
        click.handled = true;
      });
      try {
        for (const columns of [300, 100]) {
          mounted.tui.terminal.columns = columns;
          const painted = mounted.line(columns);
          const line = stripVTControlCharacters(painted);
          assert(line.endsWith("workers: unrelated · fixture-strong · YOLO"), line);
          assert(
            painted.includes("\x1b[31m\x1b[1mYOLO\x1b[22m\x1b[39m"),
            "YOLO keeps its red/bold styling",
          );
          claimed.length = 0;
          for (const label of ["YOLO", "fixture-strong"]) {
            const start = line.indexOf(label);
            mounted.clickFooter(start);
            mounted.clickFooter(start + visibleWidth(label) - 1);
          }
          assert.deepEqual(claimed, [
            "approval",
            "approval",
            WORKER_PRESET_INDICATOR,
            WORKER_PRESET_INDICATOR,
          ]);
          assert.deepEqual(mounted.visible(), [], "claimed clicks never open the usage panel");
        }
        assert.equal(
          statuses.get("approval"),
          yolo,
          "only the footer presentation changed, not published statuses",
        );
        statuses.set("approval", "manual");
        statuses.set(WORKER_PRESET_INDICATOR, "custom@v2");
        assert(
          mounted.line().endsWith("custom@v2 · manual"),
          "already compact values pass through unchanged",
        );
      } finally {
        off();
        mounted.footer.dispose();
      }
    });

    test("footer keeps worker/approval/health order and the health edge stable across status changes", async () => {
      const theme = { fg: (_color, text) => text };
      const statuses = new Map([
        [HEALTH_INDICATOR, "●"],
        ["approval", "approval: jev+sub"],
        [WORKER_PRESET_INDICATOR, "workers: off"],
      ]);
      const mounted = await mountFooter({ mode: "fullscreen", statuses });
      try {
        for (const preset of ["off", "fixture-balanced", "研究团队-custom@revision-42"]) {
          statuses.set(WORKER_PRESET_INDICATOR, `workers: ${preset}`);
          for (const state of ["idle", "busy", "waiting", "error", "unknown"]) {
            const health = healthStatus(theme, state);
            statuses.set(HEALTH_INDICATOR, health);
            const line = mounted.line(120);
            assert(line.endsWith(`${preset} · jev+sub · ${health}`), line);
            assert.equal(visibleWidth(line), 120, "health remains flush right");
          }
        }
      } finally {
        mounted.footer.dispose();
      }
    });

    test("footer sheds cache detail before complete usage figures or corner controls", async () => {
      const statuses = new Map([
        [WORKER_PRESET_INDICATOR, "workers: fixture-balanced"],
        ["approval", "approval: manual"],
        [HEALTH_INDICATOR, "●"],
      ]);
      const mounted = await mountFooter({ mode: "fullscreen", statuses, entries: spendEntries });
      try {
        const full = mounted.line(300);
        const right = full.slice(full.indexOf("↑"));
        const narrow = stripVTControlCharacters(mounted.line(visibleWidth(right) - 1));
        assert(narrow.endsWith("↑6.2k ↓788 $0.780 · fixture-balanced · manual · ●"), narrow);
        assert.equal(mounted.line(300), full, "resize restores full cache detail");
      } finally {
        mounted.footer.dispose();
      }
    });

    test("footer fitting stays bounded with any subset of pinned extensions in either renderer", async () => {
      const pinned = [
        [WORKER_PRESET_INDICATOR, "workers: custom-long-preset@v2"],
        ["approval", "approval: jev+sub"],
        [HEALTH_INDICATOR, "●"],
      ];
      for (const mode of ["fullscreen", "regular"])
        for (let mask = 0; mask < 8; mask++) {
          const statuses = new Map([
            ["other", "EXTERNAL_STATUS ".repeat(10)],
            ...pinned.filter((_entry, index) => mask & (1 << index)),
          ]);
          const mounted = await mountFooter({ mode, statuses, entries: spendEntries });
          try {
            for (let columns = 0; columns <= 120; columns++) {
              const line = stripVTControlCharacters(mounted.line(columns));
              assert(visibleWidth(line) <= columns, `${mode}/${mask}/${columns}: ${line}`);
              if (mask & 4 && columns >= 1) assert(line.endsWith("●"), line);
              if (mask & 2 && columns >= 22)
                assert(line.includes("jev+sub"), "ordinary Pi also retains approval");
            }
          } finally {
            mounted.footer.dispose();
          }
        }
    });

    test("narrow footer preserves styled approval and health, with exact ANSI/CJK click geometry after resize", async () => {
      const theme = {
        fg: (color, text) => `\x1b[${color === "error" ? 31 : 36}m${text}\x1b[39m`,
        bold: (text) => `\x1b[1m${text}\x1b[22m`,
      };
      const yolo = approvalStatus(theme, undefined, true);
      const statuses = new Map([
        [WORKER_PRESET_INDICATOR, `workers: ${theme.fg("accent", "研究团队".repeat(30) + "@v2")}`],
        ["approval", yolo],
        [HEALTH_INDICATOR, healthStatus(theme, "error")],
      ]);
      const before = [...statuses];
      const mounted = await mountFooter({
        mode: "fullscreen",
        statuses,
        theme,
        entries: spendEntries,
      });
      const claimed = [];
      const off = mounted.f.pi.events.on(FOOTER_INDICATOR_CLICK_EVENT, (click) => {
        claimed.push(click.key);
        click.handled = true;
      });
      try {
        for (const columns of [500, 80, 40, 32, 24, 18, 12, 8, 7, 1, 0, 120, 500]) {
          const painted = mounted.line(columns),
            line = stripVTControlCharacters(painted);
          assert(visibleWidth(line) <= columns, `${columns}: ${line}`);
          claimed.length = 0;
          if (columns === 0) {
            assert.equal(line, "");
            mounted.clickFooter(0);
            assert.deepEqual(claimed, [], "no stale indicator hit after a zero-width paint");
            continue;
          }
          assert(line.endsWith("●"), `${columns}: ${line}`);
          mounted.clickFooter(columns - 1);
          assert.deepEqual(
            claimed,
            [HEALTH_INDICATOR],
            "rightmost drawn cell always routes to health",
          );
          if (columns >= 8) {
            assert(line.includes("YOLO"), `${columns}: ${line}`);
            assert(
              painted.includes("\x1b[31m\x1b[1mYOLO\x1b[22m\x1b[39m"),
              "narrowing retains the full red/bold warning",
            );
            mounted.clickFooter(visibleWidth(line.slice(0, line.indexOf("YOLO"))));
            assert.equal(claimed.at(-1), "approval");
          } else {
            assert(!line.includes("YO"), "never show a misleading fragment of the approval mode");
          }
          if (line.includes("研究")) {
            const start = visibleWidth(line.slice(0, line.indexOf("研究")));
            const end = visibleWidth(line.slice(0, line.indexOf(" · ", line.indexOf("研究"))));
            claimed.length = 0;
            for (let x = start; x < end; x++) mounted.clickFooter(x);
            assert(
              claimed.length > 0 && claimed.every((key) => key === WORKER_PRESET_INDICATOR),
              "wide glyphs and a shortened label's ellipsis all belong to the worker control",
            );
            if (columns < 500)
              assert(
                line.slice(0, line.indexOf("YOLO")).includes("…"),
                "long preset is visibly shortened",
              );
          } else
            assert(
              !claimed.includes(WORKER_PRESET_INDICATOR),
              "hidden worker control has no phantom hit",
            );
          if (columns === 500)
            assert(
              line.includes("研究团队".repeat(30) + "@v2"),
              "expansion restores the original label",
            );
        }
        assert.deepEqual([...statuses], before, "fitting never mutates published status values");
      } finally {
        off();
        mounted.footer.dispose();
      }
    });
  }
  return { registerMain, registerCorner, FOOTER_HEIGHT, nextTick };
}
