// UI title checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
export function registerTitleTests(titleExtension, fixture, visibleWidth) {
  const TITLE_MARKS = /[\u0305\u0332\u0333\u033f]/;
  const plainTitle = (title) => title.replace(/[\u0305\u0332\u0333\u033f]/g, "");

  test("title animation reuses its session label until rename or cwd change", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture();
    titleExtension(f.pi);
    t.after(() => f.emit("session_shutdown"));
    await f.emit("session_start");
    const initialReads = f.sessionNameReads();
    await f.emit("agent_start");
    t.mock.timers.tick(33 * 100);
    assert.equal(f.sessionNameReads(), initialReads, "animation does not scan session history");
    f.rename("new name");
    await f.emit("session_info_changed");
    assert.equal(f.sessionNameReads(), initialReads + 1);
    assert.equal(plainTitle(f.titles.at(-1)), "π - new name");
    f.rename(undefined);
    await f.emit("session_info_changed");
    f.ctx.cwd = "/fixture/elsewhere";
    t.mock.timers.tick(33);
    assert.equal(plainTitle(f.titles.at(-1)), "π - elsewhere");
    assert.equal(f.sessionNameReads(), initialReads + 3, "fallback follows the actual cwd");
  });

  test("title highlight circles the bottom and top with connected corner frames", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture();
    titleExtension(f.pi);
    t.after(() => f.emit("session_shutdown"));
    f.rename("abcd");
    await f.emit("session_start");
    await f.emit("agent_start");
    const firstFrame = "π\u0333\u0305 - abcd";
    assert.equal(f.titles.at(-1), firstFrame, "starts at the bottom-left corner on π");
    t.mock.timers.tick(33 * 4);
    assert.equal(
      f.titles.at(-1),
      "π -\u0333 abcd",
      "the prefix separator participates in the sweep",
    );
    t.mock.timers.tick(33 * 10);
    assert.equal(
      f.titles.at(-1),
      "π - abc\u0332d\u0333\u0305",
      "bottom sweep reaches the right corner",
    );
    t.mock.timers.tick(33);
    assert.equal(
      f.titles.at(-1),
      "π - abcd\u0332\u0305",
      "half-cell frame bridges the right corner",
    );
    t.mock.timers.tick(33);
    assert.equal(f.titles.at(-1), "π - abc\u0305d\u0332\u033f", "top sweep starts on the right");
    t.mock.timers.tick(33 * 14);
    assert.equal(
      f.titles.at(-1),
      "π\u0332\u033f - abcd",
      "top sweep returns to π at the left corner",
    );
    t.mock.timers.tick(33);
    assert.equal(
      f.titles.at(-1),
      "π\u0332\u0305 - abcd",
      "half-cell frame bridges the left corner",
    );
    t.mock.timers.tick(33);
    assert.equal(f.titles.at(-1), "π - abcd", "pause starts only after a complete circuit");
    const pausedCount = f.titles.length;
    t.mock.timers.tick(33 * 59);
    assert.equal(f.titles.length, pausedCount, "the existing 1,980ms pause does not repaint");
    t.mock.timers.tick(33);
    assert.equal(f.titles.at(-1), firstFrame, "next circuit restarts at the bottom-left corner");
  });

  for (const label of [
    "a",
    "ab",
    "project",
    "two words",
    "项目配置",
    "abcdefghijklmnop",
    "long-title-".repeat(8),
  ]) {
    test(`circling title preserves glyphs and width for ${JSON.stringify(label)}`, async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const f = fixture();
      titleExtension(f.pi);
      t.after(() => f.emit("session_shutdown"));
      f.rename(label);
      await f.emit("session_start");
      const idleTitle = f.titles.at(-1);
      assert.equal(idleTitle, `π - ${label}`, "the full label is preserved without truncation");
      const characters = Array.from(idleTitle);
      // Describe the traversal explicitly, independently of the implementation's
      // circular-distance calculation. Each glyph has a bottom and a top slot.
      const bottom = characters.map((_, index) => ({ index, single: "\u0332", double: "\u0333" }));
      const top = characters
        .map((_, index) => ({ index, single: "\u0305", double: "\u033f" }))
        .reverse();
      const circuit = [...bottom, ...top];
      await f.emit("agent_start");
      const firstFrame = f.titles.at(-1);
      for (let frame = 0; frame < characters.length * 4; frame += 1) {
        const title = f.titles.at(-1);
        assert.equal(
          plainTitle(title),
          idleTitle,
          `full title including prefix unchanged at frame ${frame}`,
        );
        assert.equal(
          visibleWidth(title),
          visibleWidth(idleTitle),
          `width unchanged at frame ${frame}`,
        );
        assert(!/\s[\u0305\u0332\u0333\u033f]/u.test(title), "spaces are not decorated");
        const position = Math.floor(frame / 2);
        const offsets = frame % 2 === 0 ? [-1, 0, 1] : [0, 1];
        const activeSlots = new Set(
          offsets.map((offset) => (position + offset + circuit.length) % circuit.length),
        );
        const expectedMarks = characters.map(() => []);
        for (const slot of activeSlots) {
          const { index, single, double } = circuit[slot];
          if (/\s/u.test(characters[index])) continue;
          expectedMarks[index].push(frame % 2 === 0 && slot === position ? double : single);
        }
        const cells = [
          ...title.matchAll(/([^\u0305\u0332\u0333\u033f])([\u0305\u0332\u0333\u033f]*)/gu),
        ];
        assert.equal(cells.length, characters.length);
        for (let index = 0; index < characters.length; index += 1) {
          assert.deepEqual(
            [...cells[index][2]].sort(),
            expectedMarks[index].sort(),
            `exact center and neighbor marks at frame ${frame}, glyph ${index}`,
          );
        }
        t.mock.timers.tick(33);
      }
      assert.equal(f.titles.at(-1), idleTitle, "full circuit finishes on the static title");
      const pausedCount = f.titles.length;
      t.mock.timers.tick(33 * 59);
      assert.equal(f.titles.length, pausedCount, "pause does not repaint at any label length");
      t.mock.timers.tick(33);
      assert.equal(f.titles.length, pausedCount + 1, "pause ends after exactly 1,980ms");
      assert.equal(f.titles.at(-1), firstFrame, "next circuit restarts at the same corner");
    });
  }

  test("title keeps π while working and replaces it with ! during approval", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture();
    titleExtension(f.pi);
    t.after(() => f.emit("session_shutdown"));
    await f.emit("session_start");
    assert.equal(f.titles.at(-1), "π - project");
    // Pi core writes its default title after all session_start handlers finish.
    f.terminal.setTitle("π - project - default");
    assert.equal(f.titles.at(-1), "π - project");
    assert.deepEqual([...f.widgets.values()][0].render(80), []);
    await f.emit("agent_start");
    t.mock.timers.tick(33 * 18);
    assert.match(f.titles.at(-1), TITLE_MARKS);
    assert.equal(plainTitle(f.titles.at(-1)), "π - project");
    // A core title write during streaming must preserve the current frame too.
    const animated = f.titles.at(-1);
    f.terminal.setTitle("π - project");
    assert.equal(f.titles.at(-1), animated);
    f.rename("new");
    f.terminal.setTitle("π - new - project");
    await f.emit("session_info_changed");
    assert.equal(plainTitle(f.titles.at(-1)), "π - new");
    assert.match(f.titles.at(-1), /[\u0305\u033f]/, "renamed short label is on the upper sweep");
    f.pi.events.emit("permissions:ui_prompt", { requestId: "a" });
    f.pi.events.emit("permissions:ui_prompt", { requestId: "b" });
    assert.equal(f.titles.at(-1), "! - new");
    const pausedCount = f.titles.length;
    t.mock.timers.tick(330);
    assert.equal(f.titles.length, pausedCount, "approval pauses animation");
    f.pi.events.emit("permissions:decision", { requestId: "a" });
    assert.equal(f.titles.at(-1), "! - new");
    f.pi.events.emit("permissions:decision", { requestId: "b" });
    t.mock.timers.tick(33 * 18);
    assert.match(
      f.titles.at(-1),
      /[\u0305\u033f]/,
      "working title resumes its upper sweep after approval",
    );
    await f.emit("agent_settled");
    assert.equal(f.titles.at(-1), "✓ - new");
    const settledCount = f.titles.length;
    t.mock.timers.tick(330);
    assert.equal(f.titles.length, settledCount, "settlement stops animation");
    assert(f.titles.every((title) => /^(π|!|✓) - /.test(plainTitle(title))));
  });

  for (const sdkDispatch of [false, true]) {
    test(`settled title persists until the next run or session (SDK dispatch: ${sdkDispatch})`, async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const f = fixture("tui", sdkDispatch);
      titleExtension(f.pi);
      t.after(() => f.emit("session_shutdown"));
      await f.emit("session_start");
      await f.emit("agent_settled");
      assert.equal(f.titles.at(-1), "π - project", "no completion marker before a run");
      await f.emit("agent_start");
      await f.emit("agent_end");
      assert.equal(plainTitle(f.titles.at(-1)), "π - project", "agent_end is not final settlement");
      assert.match(f.titles.at(-1), TITLE_MARKS);
      await f.emit("agent_settled");
      assert.equal(f.titles.at(-1), "✓ - project");
      const writes = f.titles.length;
      await f.emit("agent_settled");
      t.mock.timers.tick(10_000);
      assert.equal(
        f.titles.length,
        writes,
        "settled title is static and duplicate events are harmless",
      );
      f.terminal.setTitle("core rewrite");
      assert.equal(f.titles.at(-1), "✓ - project", "core cannot erase the marker");
      f.rename("a long completed task configuration");
      await f.emit("session_info_changed");
      assert.equal(f.titles.at(-1), "✓ - a long completed task configuration");
      for (const channel of ["permissions:decision", "managed-permissions:ui_prompt_end:v1"]) {
        f.pi.events.emit("permissions:ui_prompt", { requestId: channel });
        assert.equal(f.titles.at(-1), "! - a long completed task configuration");
        f.pi.events.emit(channel, { requestId: channel });
        assert.equal(
          f.titles.at(-1),
          "✓ - a long completed task configuration",
          "approval restores the settled marker",
        );
      }
      await f.emit("agent_start");
      assert.equal(plainTitle(f.titles.at(-1)), "π - a long completed task configuration");
      assert.match(f.titles.at(-1), TITLE_MARKS, "the next run restarts animation");
      await f.emit("agent_settled");
      await f.emit("session_start");
      assert.equal(
        f.titles.at(-1),
        "π - a long completed task configuration",
        "a new session clears settlement",
      );
      await f.emit("agent_start");
      await f.emit("agent_settled");
      await f.emit("session_shutdown");
      assert.equal(
        f.titles.at(-1),
        "π - a long completed task configuration",
        "shutdown clears the managed marker",
      );
      assert.equal(f.terminal.setTitle, f.originalSetTitle);
      assert.deepEqual(f.errors, []);
    });

    test(`an aborted run settles to the plain title, not the completion marker (SDK dispatch: ${sdkDispatch})`, async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const f = fixture("tui", sdkDispatch);
      titleExtension(f.pi);
      t.after(() => f.emit("session_shutdown"));
      await f.emit("session_start");
      await f.emit("agent_start");
      await f.emit("agent_settled", { aborted: true });
      assert.equal(f.titles.at(-1), "π - project", "an Escape needs no completion marker");
      const writes = f.titles.length;
      t.mock.timers.tick(330);
      assert.equal(f.titles.length, writes, "an aborted run stops animation");
      await f.emit("agent_start");
      await f.emit("agent_settled", { aborted: false });
      assert.equal(f.titles.at(-1), "✓ - project", "the next completed run still asks for a look");
      await f.emit("agent_start");
      await f.emit("agent_settled", { aborted: true });
      assert.equal(f.titles.at(-1), "π - project", "a later abort replaces the earlier marker");
      assert.deepEqual(f.errors, []);
    });
  }

  for (const running of [false, true]) {
    test(`expired approval restores the ${running ? "working" : "idle"} title without a matching decision`, async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const f = fixture();
      titleExtension(f.pi);
      t.after(() => f.emit("session_shutdown"));
      await f.emit("session_start");
      if (running) await f.emit("agent_start");
      f.pi.events.emit("permissions:ui_prompt", { requestId: "expired" });
      assert.equal(f.titles.at(-1), "! - project");
      // Upstream's fail-closed exception boundary mints a different request ID.
      f.pi.events.emit("permissions:decision", {
        requestId: "gate-error",
        resolution: "gate_error",
        result: "deny",
      });
      assert.equal(f.titles.at(-1), "! - project");
      f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "expired" });
      assert.equal(plainTitle(f.titles.at(-1)), "π - project");
      t.mock.timers.tick(33 * 8);
      assert.equal(
        TITLE_MARKS.test(f.titles.at(-1)),
        running,
        "only actual work resumes animation",
      );
      f.terminal.setTitle("core rewrite");
      assert.equal(
        plainTitle(f.titles.at(-1)),
        "π - project",
        "core writes cannot resurrect the expired marker",
      );
    });
  }

  test("ending one approval never clears another, including a worker ask after parent settlement", async (t) => {
    const f = fixture();
    titleExtension(f.pi);
    t.after(() => f.emit("session_shutdown"));
    await f.emit("session_start");
    await f.emit("agent_start");
    f.pi.events.emit("permissions:ui_prompt", { requestId: "local" });
    f.pi.events.emit("permissions:ui_prompt", {
      requestId: "worker",
      forwarding: { requesterSessionId: "child" },
    });
    await f.emit("agent_settled");
    await f.emit("ui_prompt_end", { kind: "custom" });
    for (const value of [
      null,
      undefined,
      {},
      { requestId: "" },
      { requestId: 7 },
      { requestId: "unrelated" },
    ]) {
      f.pi.events.emit("managed-permissions:ui_prompt_end:v1", value);
    }
    assert.equal(f.titles.at(-1), "! - project");
    f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "local" });
    f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "local" });
    f.pi.events.emit("permissions:decision", { requestId: "local" });
    assert.equal(
      f.titles.at(-1),
      "! - project",
      "late/duplicate local events leave the worker ask intact",
    );
    f.pi.events.emit("managed-permissions:ui_prompt_end:v1", { requestId: "worker" });
    assert.equal(
      f.titles.at(-1),
      "✓ - project",
      "completion appears only after the final pending approval ends",
    );
    const writes = f.titles.length;
    f.pi.events.emit("permissions:decision", { requestId: "worker" });
    assert.equal(f.titles.length, writes, "the eventual decision is an idempotent fallback");
  });

  test("title sanitizes labels and releases timers/listeners at shutdown", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture();
    titleExtension(f.pi);
    f.rename("  abcdefghijklmnop\n\x07  project configuration  ");
    await f.emit("session_start");
    assert.equal(f.titles.at(-1), "π - abcdefghijklmnop project configuration");
    await f.emit("agent_start");
    t.mock.timers.tick(330);
    f.pi.events.emit("permissions:ui_prompt", { requestId: "long-title" });
    assert.equal(
      f.titles.at(-1),
      "! - abcdefghijklmnop project configuration",
      "approval also preserves the full label",
    );
    await f.emit("session_shutdown");
    assert.equal(f.titles.at(-1), "π - abcdefghijklmnop project configuration");
    const count = f.titles.length;
    t.mock.timers.tick(330);
    f.pi.events.emit("permissions:ui_prompt", { requestId: "late" });
    assert.equal(f.titles.length, count);
    assert([...f.listeners.values()].every((set) => set.size === 0));
    assert.equal(f.terminal.setTitle, f.originalSetTitle);
    assert.equal(f.widgets.size, 0);
  });

  test("non-TUI sessions do not set terminal titles", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    for (const mode of ["rpc", "json", "print"]) {
      const f = fixture(mode);
      titleExtension(f.pi);
      await f.emit("session_start");
      await f.emit("agent_start");
      t.mock.timers.tick(330);
      await f.emit("session_info_changed");
      await f.emit("agent_settled");
      await f.emit("session_shutdown");
      assert.deepEqual(f.titles, []);
    }
  });
}
