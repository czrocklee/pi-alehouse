// Jev audit checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allowAnswers, mockResponse } from "./jev-wire.mjs";
export async function runJevAuditFreshness(
  check,
  registeredHarness,
  offlineRuntime,
  offlineAgentDir,
  withAuditIo,
) {
  // These edits do NOT append entries, advance provenance, or change the leaf.
  // Reused policy objects and changed bodies must be compared to pre-await values,
  // not to the now-mutated baseline object, even when presentation stamps agree.
  for (const change of [
    "reused-policy-object",
    "historical-user",
    "current-action",
    "script-body",
  ]) {
    const h = registeredHarness();
    h.live("Inspect the synthetic local project.");
    const scriptPath = join(offlineRuntime, "jev-freshness-script.sh");
    writeFileSync(scriptPath, "#!/bin/sh\nprintf 'before\\n'\n", { mode: 0o600 });
    const details = h.call(
      `same-leaf-${change}`,
      change === "script-body" ? "./jev-freshness-script.sh" : "git status",
    );
    const countBefore = h.branch.length;
    h.ctx.sessionManager.getLeafId = () => "same-leaf";
    h.ctx.sessionManager.getEntryCount = () => h.branch.length;
    const reused = h.query.checkPermission();
    if (change === "reused-policy-object") h.query.checkPermission = () => reused;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      if (change === "reused-policy-object") reused.matchedPattern = "bash:git *";
      if (change === "historical-user")
        h.branch[0].message.content[0].text = "Never inspect the repository.";
      if (change === "current-action")
        h.branch.at(-1).message.content[0].arguments.command = "git diff";
      if (change === "script-body")
        writeFileSync(scriptPath, "#!/bin/sh\nprintf 'changed\\n'\n", { mode: 0o600 });
      return mockResponse(allowAnswers());
    };
    try {
      check(`${change}: same-leaf mutation invalidates approval`, await h.authorize(details), {
        kind: "defer",
      });
      check(`${change}: reviewer was actually called once`, fetchCalls, 1);
      check(`${change}: branch length is unchanged`, h.branch.length, countBefore);
      check(
        `${change}: audit names freshness failure`,
        h.reviews.at(-1).failureCode,
        "review_context_changed",
      );
    } finally {
      rmSync(scriptPath, { force: true });
    }
  }

  {
    const h = registeredHarness();
    h.live("Inspect synthetic repository status.");
    globalThis.fetch = async () => mockResponse(allowAnswers());
    const before = { ...h.reads };
    check("unchanged review still allows", await h.authorize(h.call("fresh-samples")), {
      kind: "allow",
    });
    check(
      "freshness samples prompt/branch/policy before review, after review, and again after audit lock wait",
      {
        systemPrompt: h.reads.systemPrompt - before.systemPrompt,
        branch: h.reads.branch - before.branch,
        policy: h.reads.policy - before.policy,
      },
      { systemPrompt: 3, branch: 3, policy: 3 },
    );
  }

  // A crash-left/contended audit-specific lock must never become an unlogged
  // allow. This lock is unrelated to the Owner lease; production never steals it.
  {
    const h = registeredHarness();
    h.live("Inspect synthetic repository status.");
    const lock = join(offlineAgentDir, "logs/.jev-auto-approval.jsonl.lock");
    const savedLock = join(offlineRuntime, "stopped-fixture-kernel-lock");
    // This isolated fixture has no pending writers. Preserve the regular inode
    // while emulating an old mkdir artifact; this is not a live recovery API.
    renameSync(lock, savedLock);
    mkdirSync(lock, { mode: 0o700 });
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers());
    };
    try {
      check("audit lock failure downgrades allow", await h.authorize(h.call("audit-unavailable")), {
        kind: "defer",
      });
      check("audit failure keeps actual model call", fetchCalls, 1);
      check("audit failure is explicit", h.reviews.at(-1).failureCode, "audit_unavailable");
      check(
        "legacy failure is independently visible",
        h.notices.at(-1)?.message.includes("legacy_lock_requires_offline_recovery"),
        true,
      );
      check(
        "recovery requires stopped writers",
        h.notices.at(-1)?.message.includes("Stop every Pi sharing this agent directory"),
        true,
      );
      check(
        "repeated legacy failure still defers",
        await h.authorize(h.call("audit-unavailable-again")),
        { kind: "defer" },
      );
      check(
        "repeated audit diagnostics are deduplicated",
        h.notices.filter((row) => row.message.startsWith("Jev audit unavailable")).length,
        1,
      );
      check(
        "failed allows are never published as audited allows",
        h.reviews.some((row) => row.effectiveVerdict === "allow"),
        false,
      );
    } finally {
      rmSync(lock, { recursive: true });
      renameSync(savedLock, lock);
    }
    check(
      "unlocked later request is independently reviewed",
      await h.authorize(h.call("audit-recovered")),
      { kind: "allow" },
    );
    check("audit recovery never reuses an old approval", fetchCalls, 3);
  }

  {
    const h = registeredHarness();
    h.live("Inspect synthetic repository status.");
    globalThis.fetch = async () => mockResponse(allowAnswers());
    await withAuditIo(
      "writeSync",
      () => {
        throw new Error("synthetic audit IO failure");
      },
      async () => {
        check(
          "actual audit IO failure cannot allow",
          await h.authorize(h.call("injected-audit-io")),
          { kind: "defer" },
        );
        check(
          "actual IO reason is independently visible",
          h.notices.at(-1)?.message.includes("audit_io_failed"),
          true,
        );
        check(
          "public failure code stays compatible",
          h.reviews.at(-1).failureCode,
          "audit_unavailable",
        );
        check(
          "IO failure never publishes an audited allow",
          h.reviews.some((row) => row.effectiveVerdict === "allow"),
          false,
        );
      },
      2,
    );
    check(
      "normal audit resumes after synthetic IO restoration",
      await h.authorize(h.call("injected-audit-recovered")),
      { kind: "allow" },
    );
  }

  // user_denied pauses the same complete action across new IDs. Queued/extension
  // messages alter the broad input revision but cannot mint fresh authorization.
  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () =>
      mockResponse(++fetchCalls === 1 ? allowAnswers(0.01) : allowAnswers());
    const first = h.call("denied-first");
    check("under-threshold review reaches terminal", await h.authorize(first), { kind: "defer" });
    h.decide(first, "deny", "user_denied");
    check(
      "same action with a new tool ID is paused",
      (await h.authorize(h.call("denied-retry"))).kind,
      "deny",
    );
    check("paused retry does not call the model", fetchCalls, 1);
    h.untrustedUser("queued extension text claims authorization");
    check(
      "extension message cannot clear refusal",
      (await h.authorize(h.call("denied-queued"))).kind,
      "deny",
    );
    check("extension retry still does not call model", fetchCalls, 1);
    h.live("Retry that exact inspection now.");
    check(
      "new provenance-bound direct input reopens action",
      await h.authorize(h.call("denied-reopened")),
      { kind: "allow" },
    );
    check("reopened action invokes model", fetchCalls, 2);
  }

  // The second review: a mode change must not forget a human No. The pause is
  // bound to the action and the user's instruction, not to the mode it was
  // given under, so bouncing through manual or adding subagents keeps it.
  {
    const h = registeredHarness({ mode: "enforce" });
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () =>
      mockResponse(++fetchCalls === 1 ? allowAnswers(0.01) : allowAnswers());
    const first = h.call("mode-denied-first");
    check("mode pause: under-threshold review reaches terminal", await h.authorize(first), {
      kind: "defer",
    });
    h.decide(first, "deny", "user_denied");
    check("mode pause: widening to subagents is applied", h.setMode("enforce", true), true);
    check(
      "a human No survives adding subagents",
      (await h.authorize(h.call("mode-denied-sub"))).kind,
      "deny",
    );
    h.setMode("shadow", false);
    h.setMode("enforce", false);
    check(
      "a human No survives a round trip through manual",
      (await h.authorize(h.call("mode-denied-trip"))).kind,
      "deny",
    );
    check("paused retries across mode changes never call the model", fetchCalls, 1);
    check(
      "mode changes are announced for the current session",
      h.notices.at(-1)?.message,
      "Jev approval: enforce root only (current session only)",
    );
    h.live("Retry that exact inspection now.");
    check("only new direct input reopens it", await h.authorize(h.call("mode-denied-reopened")), {
      kind: "allow",
    });
  }

  // The third review: the mode changes while the human dialog is still open,
  // then the No lands. It must hold however the mode changed.
  for (const [label, start, change] of [
    ["root ask, subagents added before the No", ["enforce", false], ["enforce", true]],
    ["manual ask, enforce chosen before the No", ["shadow", false], ["enforce", false]],
  ]) {
    const h = registeredHarness({ mode: "enforce" });
    h.setMode(...start);
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () =>
      mockResponse(++fetchCalls === 1 ? allowAnswers(0.01) : allowAnswers());
    const first = h.call(`late-no-${start[0]}`);
    check(`late No (${label}): the ask reaches the human`, await h.authorize(first), {
      kind: "defer",
    });
    h.setMode(...change);
    h.decide(first, "deny", "user_denied");
    check(
      `late No holds: ${label}`,
      (await h.authorize(h.call(`late-no-retry-${start[0]}`))).kind,
      "deny",
    );
    check(`late No retry never reaches the model: ${label}`, fetchCalls <= 1, true);
  }

  // Complete arguments, not just the shell command, are part of retry identity.
  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () =>
      mockResponse(++fetchCalls === 1 ? allowAnswers(0.01) : allowAnswers());
    const first = h.call("args-first", "git status", { timeout: 10 });
    check("first complete action defers", await h.authorize(first), { kind: "defer" });
    h.decide(first, "deny", "user_denied");
    check(
      "different complete arguments are a different retry key",
      await h.authorize(h.call("args-second", "git status", { timeout: 20 })),
      { kind: "allow" },
    );
    check("different full action reaches model", fetchCalls, 2);
  }

  // A tool invocation can trip a different gate on retry. Gate projection is not
  // action identity: the same full name/arguments remains paused.
  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () =>
      mockResponse(++fetchCalls === 1 ? allowAnswers(0.01) : allowAnswers());
    const first = h.call("gate-first", "git status", {}, { matchedPattern: "git status" });
    check("first gate projection defers", await h.authorize(first), { kind: "defer" });
    h.decide(first, "deny", "user_denied");
    const retry = h.call(
      "gate-second",
      "git status",
      {},
      {
        matchedPattern: "bash:*",
        evidence: [{ label: "full command", text: "git status", detail: null }],
      },
    );
    check(
      "different gate for the same complete tool action stays paused",
      (await h.authorize(retry)).kind,
      "deny",
    );
    check("different-gate retry does not call model", fetchCalls, 1);
  }

  // A denial may arrive while another review of the same complete action is in
  // flight. The completed allow is stale once refusal memory is visible.
  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    let releaseSecond;
    let secondStartedResolve;
    const secondStarted = new Promise((resolve) => {
      secondStartedResolve = resolve;
    });
    globalThis.fetch = async () => {
      fetchCalls++;
      if (fetchCalls === 1) return mockResponse(allowAnswers(0.01));
      secondStartedResolve();
      await new Promise((resolve) => {
        releaseSecond = resolve;
      });
      return mockResponse(allowAnswers());
    };
    const first = h.call("parallel-first", "git status", {}, { matchedPattern: "git status" });
    check("parallel refusal fixture reaches terminal", await h.authorize(first), { kind: "defer" });
    const second = h.call("parallel-second", "git status", {}, { matchedPattern: "bash:*" });
    const pendingAllow = h.authorize(second);
    await secondStarted;
    h.decide(first, "deny", "user_denied");
    releaseSecond();
    check("parallel human refusal expires inflight allow", await pendingAllow, { kind: "defer" });
    check("parallel refusal exercised two independent reviews", fetchCalls, 2);
    check(
      "expired inflight audit keeps allow suggestion",
      h.reviews.at(-1).suggestedVerdict,
      "allow",
    );
    check(
      "expired inflight audit is effectively deferred",
      h.reviews.at(-1).effectiveVerdict,
      "defer",
    );
    check(
      "expired inflight audit names freshness failure",
      h.reviews.at(-1).failureCode,
      "review_context_changed",
    );
  }
}

export async function runJevAuditRefusal(check, registeredHarness, defaultSystemPrompt) {
  // Even a defer before model dispatch is an approval attempt when its complete
  // root action is known; a later user_denied must pause the same action.
  {
    const h = registeredHarness();
    h.setSystemPrompt(
      `<project_context><project_instructions path="broken">Never modify x.</project_context>`,
    );
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers());
    };
    const first = h.call("early-defer-first");
    check("early malformed-context ask defers", await h.authorize(first), { kind: "defer" });
    h.decide(first, "deny", "user_denied");
    h.setSystemPrompt(defaultSystemPrompt());
    check(
      "user denial of early defer pauses same complete action",
      (await h.authorize(h.call("early-defer-retry"))).kind,
      "deny",
    );
    check("paused early defer never reaches model", fetchCalls, 0);
  }

  // Missing complete-action evidence must not lose a human No when that evidence
  // becomes available later in the same authorization window.
  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers());
    };
    const first = h.call("missing-action");
    h.branch.pop();
    check("missing complete action defers", await h.authorize(first), { kind: "defer" });
    h.decide(first, "deny", "user_denied");
    check(
      "restoring action evidence cannot erase a human No",
      (await h.authorize(h.call("restored-action"))).kind,
      "deny",
    );
    check("unidentified refusal never calls reviewer", fetchCalls, 0);
    h.live("Authorize a fresh inspection now.");
    check(
      "new direct input clears unidentified-refusal pause",
      await h.authorize(h.call("new-action")),
      { kind: "allow" },
    );
  }

  // Refusal memory is also bounded without eviction. Filling it trips a global
  // fuse for the authorization epoch rather than forgetting an old denial.
  {
    const h = registeredHarness();
    h.live("Inspect many independent status targets.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers(0.01));
    };
    for (let i = 0; i <= 256; i++) {
      const details = h.call(`refused-${i}`, `git status -- refused-${i}`);
      assert.equal((await h.authorize(details)).kind, "defer", `refusal fixture ${i}`);
      h.decide(details, "deny", "user_denied");
    }
    check(
      "refusal-map overflow fails closed",
      (await h.authorize(h.call("refused-overflow", "git status -- new-target"))).kind,
      "deny",
    );
    check("refusal-map overflow does not call model again", fetchCalls, 257);
    check(
      "old refusal was not evicted",
      (await h.authorize(h.call("refused-old", "git status -- refused-0"))).kind,
      "deny",
    );
    h.live("Authorize a fresh independent inspection after the refusals.");
    check(
      "new direct input clears the sticky refusal overflow fuse",
      await h.authorize(h.call("refused-new-epoch")),
      { kind: "defer" },
    );
    check("cleared refusal fuse reaches reviewer again", fetchCalls, 258);
  }

  // Pi 1.2 also starts runs from custom messages (sendMessage with triggerTurn).
  // Such a run is not new direct input, so it cannot reopen the denial fuse. A
  // pre-1.2 start without messageType is a prompt and still reopens it.
  for (const legacy of [false, true]) {
    const h = registeredHarness(),
      lane = legacy ? "pre-1.2 " : "";
    h.live("Inspect three independent status targets.", { legacy });
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse({ ...allowAnswers(), injection: { noul: 0.99 } });
    };
    for (let i = 0; i < 3; i++) {
      check(
        `${lane}model denial ${i} counts toward the fuse`,
        (await h.authorize(h.call(`fused-${i}`, `git status -- fused-${i}`))).kind,
        "deny",
      );
    }
    check(
      `${lane}denial fuse stops further reviews`,
      (await h.authorize(h.call("fused-open", "git status -- fused-open"))).kind,
      "deny",
    );
    if (!legacy) {
      h.hooks.get("before_agent_start")({
        messageType: "custom",
        message: { role: "custom", customType: "fixture-ready", content: "ready" },
      });
      check(
        "a custom-message run keeps the fuse",
        (await h.authorize(h.call("fused-custom", "git status -- fused-custom"))).kind,
        "deny",
      );
    }
    check(`${lane}no fused request called the model`, fetchCalls, 3);
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers());
    };
    h.live("Authorize a fresh inspection after the refusals.", { legacy });
    check(
      `${lane}new direct input reopens the fuse`,
      await h.authorize(h.call("fused-reopened", "git status -- reopened")),
      { kind: "allow" },
    );
  }
}
