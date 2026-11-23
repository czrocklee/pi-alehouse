import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderFixture } from "../../scripts/checks/check-render-fixture.mjs";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

test("full fixture alone receives exact synthetic executable allowances; readonly/Jev retain the conservative baseline", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "alehouse-policy-lanes-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const original = json(join(repo, "test/policy/permissions.json"));
  for (const lane of ["full", "readonly", "jev"]) {
    const agent = join(scratch, lane),
      output = join(scratch, "evidence", lane);
    renderFixture(repo, agent, output, lane);
    const config = json(join(agent, "extensions/pi-permission-system/config.json"));
    if (lane === "full") {
      for (const relative of ["child/inspect-fd.cjs", "p1-child/cooperative.cjs"]) {
        const path = join(output, relative),
          command = `${process.execPath} ${path}`;
        assert.equal(config.permission.bash[command], "allow");
        assert.equal(config.permission.path[path], "allow");
        delete config.permission.bash[command];
        delete config.permission.path[path];
      }
    }
    assert.deepEqual(
      config,
      original,
      `${lane}: denies and original asks/allowances must remain unchanged`,
    );
  }
  assert.deepEqual(
    json(join(repo, "test/policy/permissions.json")),
    original,
    "rendering never mutates the baseline",
  );
});

test("portable production seed preserves explicit secret/privilege denies and neutral routing independently of the historical fixture", () => {
  const seed = json(join(repo, "resources/permissions.json"));
  const action = (rule) => (typeof rule === "string" ? rule : rule.action);
  assert.equal(seed.yoloMode, false);
  for (const path of ["*.env", "~/.ssh/*", "~/.pi/agent/auth.json", "/run/secrets/*"])
    assert.equal(action(seed.permission.path[path]), "deny", path);
  for (const command of ["sudo *", "doas *", "su *", "rm -rf /"])
    assert.equal(action(seed.permission.bash[command]), "deny", command);
  assert.equal(seed.permission.bash["*"], "ask");
  assert.equal(json(join(repo, "resources/alehouse-presets.json")).defaultPreset, "off");
});
