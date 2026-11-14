import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { toolArgumentText, singleLineToolArgumentText } = await jiti.import(
  "../../src/orchestration/presentation/tool-argument-text.ts",
);

test("argument protocols retain every ordinary payload byte, including malformed CSI", () => {
  const samples = [
    ["printf '\x1b[123; echo keep-me'", "printf '\\x1b[123; echo keep-me'"],
    ["\x1b[2Jecho visible\x1b[0m", "\\x1b[2Jecho visible\\x1b[0m"],
    ["\x1b]0;echo payload\x07tail", "\\x1b]0;echo payload\\x07tail"],
    ["\x1b]52;c;payload\x1b\\tail", "\\x1b]52;c;payload\\x1b\\\\tail"],
    ["\x1b]0;unfinished\necho retained", "\\x1b]0;unfinished\necho retained"],
    ["\x9d52;c;payload\x9ctail", "\\x9d52;c;payload\\x9ctail"],
    ["\x1bPbody\x1b\\tail", "\\x1bPbody\\x1b\\\\tail"],
  ];
  for (const [source, expected] of samples) {
    assert.equal(toolArgumentText(source), expected);
    assert.equal(singleLineToolArgumentText(source), expected.replace(/\n/g, "\\n"));
  }
});

test("controls and their literal backslash spellings cannot collide", () => {
  for (let code = 0; code <= 0x9f; code++) {
    if (code > 0x1f && code < 0x7f) continue;
    const char = String.fromCharCode(code);
    const visible = `\\x${code.toString(16).padStart(2, "0")}`;
    assert.equal(toolArgumentText(char), code === 10 ? "\n" : visible);
    assert.equal(toolArgumentText(visible), `\\${visible}`);
    assert.notEqual(toolArgumentText(char), toolArgumentText(visible));
  }
  assert.equal(singleLineToolArgumentText("\n"), "\\n");
  assert.equal(singleLineToolArgumentText("\\n"), "\\\\n");
});

test("tabs are visible but Unicode whitespace, UTF-16 and code indentation stay literal", () => {
  const unicode = "\u00a0\u3000\u2028\u2029👩‍💻♥️e\u0301می‌روم\ud800";
  const source = `  first\t${unicode}\r\n  second  `;
  assert.equal(toolArgumentText(source), `  first\\x09${unicode}\\x0d\n  second  `);
  assert.equal(singleLineToolArgumentText(source), `  first\\x09${unicode}\\x0d\\n  second  `);
  assert.equal(source, `  first\t${unicode}\r\n  second  `, "execution text is unchanged");
});

test("all bidi controls are explicit and distinct from original escape spellings", () => {
  const bidi = [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  for (const code of bidi) {
    const encoded = `\\u${code.toString(16).padStart(4, "0")}`;
    assert.equal(toolArgumentText(String.fromCharCode(code)), encoded);
    assert.equal(toolArgumentText(encoded), `\\${encoded}`);
  }
});
