import assert from "node:assert/strict";
import test from "node:test";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { composeNet } = await jiti.import("../../src/orchestration/runtime/owner-change-net.ts");
const { observeEditPatch, finishEditPatch } = await jiti.import(
  "../../src/orchestration/runtime/owner-change-patch.ts",
);
const verified = (details) =>
  finishEditPatch(observeEditPatch(details, "f", "/project/f"), { details }).net;
const h = (body) => verified({ diff: "display", patch: `--- f\n+++ f\n${body}\n` });
const change = (line, from, to) => h(`@@ -${line},1 +${line},1 @@\n-${from}\n+${to}`);
const known = (chain) => {
  const net = composeNet(chain);
  assert.equal(net.kind, "edit");
  assert.equal(net.redacted, false);
  assert(Object.isFrozen(net));
  assert(Object.isFrozen(net.lines));
  return net;
};
const unknown = (chain) => assert.equal(composeNet(chain).kind, "unavailable");
const rows = (chain) => known(chain).lines.map(({ kind, line, text }) => [kind, line, text]);

test("composes a real pinned SDK multi-hunk chain over its first observed preimage, not requested text", async () => {
  const context = "arbitrary context, excluded from evidence";
  let text =
    `first ‘before’\r\n${context}\r\n` +
    Array.from({ length: 100 }, (_, i) => `ambient-${i}\r\n`).join("") +
    "tail";
  const sdk = createEditTool("/project", {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(text),
      writeFile: async (_p, value) => {
        text = value;
      },
    },
  });
  const edit = async (...pairs) =>
    verified(
      (
        await sdk.execute("edit", {
          path: "f",
          edits: pairs.map(([oldText, newText]) => ({ oldText, newText })),
        })
      ).details,
    );
  const one = await edit(["first 'before'", "intermediate\nadded"], ["tail", "new-tail"]);
  const two = await edit(["intermediate", "first ‘before’"]);
  const three = await edit(["first ‘before’\nadded", "first ‘before’"], ["new-tail", "tail"]);
  assert(!JSON.stringify(one).includes(context));
  assert.deepEqual(rows([one, two]), [
    ["add", 2, "added"],
    ["remove", 103, "tail"],
    ["add", 104, "new-tail"],
  ]);
  assert.deepEqual(known([one, two, three]), {
    kind: "edit",
    added: 0,
    removed: 0,
    truncated: false,
    redacted: false,
    lines: [],
  });
});

test("opaque repeated lines cannot certify nonzero net, including within one SDK multi-hunk report", async () => {
  const base = "header\n" + "A\n".repeat(180) + "tail\n";
  let text = base;
  const sdk = createEditTool("/project", {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(text),
      writeFile: async (_p, value) => {
        text = value;
      },
    },
  });
  const edit = async (...pairs) => {
    const result = await sdk.execute("edit", {
      path: "f",
      edits: pairs.map(([oldText, newText]) => ({ oldText, newText })),
    });
    const evidence = verified(result.details);
    assert(evidence, "a complete verified report (not an input rejection)");
    return evidence;
  };
  const one = await edit(["header\n", "header\nA\n"]);
  const two = await edit(["A\ntail\n", "tail\n"]);
  assert.equal(text, base);
  unknown([one, two]);
  const multi = await edit(["header\n", "header\nA\n"], ["A\ntail\n", "TAIL\n"]);
  assert(multi.hunks.length >= 2);
  assert.equal(text, base.replace("tail", "TAIL"));
  unknown([multi]);
  // Both conflicting residuals occur beyond the 24 displayed rows.
  unknown([
    ...Array.from({ length: 12 }, (_, i) => change(i + 1, "x", "y")),
    h("@@ -50,0 +51,1 @@\n+A\n@@ -150,1 +150,0 @@\n-A"),
  ]);
});

test("matches by coordinates and row identity; one unverified overlap blocks the whole net", () => {
  const one = h("@@ -8,3 +8,3 @@\n before-context\n-a\n+b\n after-context");
  const good = h("@@ -8,3 +8,3 @@\n before-context\n-b\n+c\n after-context");
  assert.deepEqual(rows([one, good]), [
    ["remove", 9, "a"],
    ["add", 9, "c"],
  ]);
  for (const bad of [change(9, "a", "c"), change(8, "foreign", "before-context"), undefined])
    unknown([one, bad, good]);
  // Never cancel by text across opaque intervening lines, or assume their
  // contents force a separate surviving replacement at each location.
  unknown([one, change(20, "b", "a")]);
  unknown([]);
});

test("zero-count ranges, very distant shifts and surviving original numbers use sparse coordinates", () => {
  const distant = 1000000001;
  const insert = h(`@@ -0,0 +1,2 @@\n+x\n+y\n@@ -${distant},1 +${distant + 1},0 @@\n-late`);
  const undoPart = h(`@@ -1,1 +0,0 @@\n-x\n@@ -${distant + 1},0 +${distant + 1},1 @@\n+late`);
  assert.deepEqual(rows([insert, undoPart]), [["add", 1, "y"]]);
  const replace = change(distant + 1, "late", "new-late");
  assert.deepEqual(rows([insert, undoPart, replace]), [
    ["add", 1, "y"],
    ["remove", distant, "late"],
    ["add", distant + 1, "new-late"],
  ]);
});

test("comparing equal row IDs keeps context private and preserves shortest-script tie order", () => {
  const one = h("@@ -1,2 +1,2 @@\n \tincidental\n-old\n+new");
  assert.deepEqual(rows([one]), [
    ["remove", 2, "old"],
    ["add", 2, "new"],
  ]);
  const two = change(1, "\tincidental", "\\tincidental");
  assert.deepEqual(rows([one, two]), [
    ["remove", 1, "\\tincidental"],
    ["remove", 2, "old"],
    ["add", 1, "\\\\tincidental"],
    ["add", 2, "new"],
  ]);

  // Matching the equal suffix eagerly would move the addition to line 2.
  assert.deepEqual(rows([h("@@ -1,3 +1,3 @@\n-a\n-b\n-a\n+b\n+a\n+a")]), [
    ["remove", 1, "a"],
    ["add", 3, "a"],
  ]);
});

test("surviving rows replay the final state of bounded insertion/deletion chains with duplicate lines", () => {
  let state = 27;
  const pick = (n) => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n;
  for (let example = 0; example < 60; example++) {
    const base = Array.from({ length: 5 }, () => String(pick(3)));
    const file = [...base],
      chain = [];
    for (let i = 0; i < 8; i++) {
      const pos = pick(file.length + 1),
        drop = Math.min(pick(3), file.length - pos);
      const insert = Array.from({ length: drop ? pick(3) : 1 }, () => String(pick(3)));
      const prior = file.splice(pos, drop, ...insert);
      const header = `@@ -${pos + Number(drop > 0)},${drop} +${pos + Number(insert.length > 0)},${insert.length} @@`;
      chain.push(
        h([header, ...prior.map((s) => `-${s}`), ...insert.map((s) => `+${s}`)].join("\n")),
      );
      const net = composeNet(chain);
      if (net.kind === "unavailable") {
        assert(i > 0, "a single complete local edit has no opaque interior");
        continue; // Sparse evidence may not determine the shortest diff.
      }
      assert(!net.truncated);
      // Independent dense oracle on the fixture's actual bytes. Replay alone
      // accepts nonminimal scripts, even manufactured +/- for an unchanged file.
      let prev = Array.from({ length: file.length + 1 }, (_, i) => i);
      for (const [i, s] of base.entries()) {
        const next = [i + 1];
        for (const [j, t] of file.entries())
          next.push(s === t ? prev[j] : 1 + Math.min(prev[j + 1], next[j]));
        prev = next;
      }
      assert.equal(net.added + net.removed, prev.at(-1));
      const replay = [...base];
      for (const { line, text } of net.lines.filter((r) => r.kind === "remove").reverse())
        assert.deepEqual(replay.splice(line - 1, 1), [text]);
      for (const { line, text } of net.lines.filter((r) => r.kind === "add"))
        replay.splice(line - 1, 0, text);
      assert.deepEqual(replay, file);
    }
  }
});

test("line ending evidence distinguishes newline-only changes, inconsistent EOF and malformed markers", () => {
  const nl = "\\ No newline at end of file";
  const removeLf = h(`@@ -1,1 +1,1 @@\n-last\n+last\n${nl}`);
  const restore = h(`@@ -1,1 +1,1 @@\n-last\n${nl}\n+last`);
  assert.deepEqual(rows([removeLf]), [
    ["remove", 1, "last"],
    ["add", 1, "last"],
  ]);
  assert.deepEqual(
    known([removeLf]).lines.map((r) => r.noLf),
    [undefined, true],
  );
  assert.deepEqual(
    known([restore]).lines.map((r) => r.noLf),
    [true, undefined],
  );
  assert.deepEqual(rows([removeLf, restore]), []);
  unknown([removeLf, change(1, "last", "else")]);
  unknown([removeLf, change(200, "tail", "else")]);
  unknown([removeLf, h("@@ -1,0 +2,1 @@\n+invalid after EOF")]);
  unknown([restore, h(`@@ -1,1 +1,1 @@\n-last\n${nl}\n+oops`)]);
  unknown([h(`@@ -1,2 +1,2 @@\n-bad\n${nl}\n-still here\n+x\n+y`)]);
  const append = h("@@ -1,0 +2,1 @@\n+suffix");
  const drop = h("@@ -2,1 +1,0 @@\n-suffix");
  assert.deepEqual(rows([append, drop]), []);
  // Once a later report attests an unterminated baseline tail, that earlier
  // append is unverifiable even though it was undone before EOF was observed.
  unknown([append, drop, h(`@@ -1,1 +1,1 @@\n-last\n${nl}\n+latter\n${nl}`)]);
});

test("refuses clipped or withheld text rather than matching its placeholder; budgets bound evidence and diff", () => {
  const valid = change(1, "b", "c");
  unknown([change(1, "a", "password=someone"), valid]);
  unknown([change(1, "a", "x".repeat(257)), valid]);
  const revert = change(1, "c", "b");
  assert.deepEqual(rows([valid, revert]), []);
  assert.equal(
    composeNet(Array.from({ length: 257 }, (_, i) => (i % 2 ? revert : valid))).reason,
    "oversized",
  );
  const manyContext = (n, offset) =>
    h(`@@ -${offset},${n + 1} +${offset},${n + 1} @@\n` + " ok\n".repeat(n) + "-x\n+y");
  assert.deepEqual(rows([manyContext(253, 1)]), [
    ["remove", 254, "x"],
    ["add", 254, "y"],
  ]);
  unknown([manyContext(254, 1)]);
  unknown([
    h("@@ -1,254 +1,254 @@\n" + " ok\n".repeat(253) + "-x\n+y\n\\ No newline at end of file"),
  ]);
  assert.equal(composeNet([manyContext(199, 1), manyContext(199, 1000)]).reason, "oversized");
  const net = known(Array.from({ length: 15 }, (_, i) => change(2 * i + 1, "x", "y")));
  assert.equal(net.truncated, true);
  assert.equal(net.lines.length, 24);
  assert.equal(net.added, 15);
  assert.equal(net.removed, 15);
});
