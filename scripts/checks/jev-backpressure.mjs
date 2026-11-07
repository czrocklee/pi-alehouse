// Jev backpressure checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { allowAnswers, hashJson, mockResponse } from "./jev-wire.mjs";
export async function runJevBackpressure(
  check,
  registeredHarness,
  offlineAgentDir,
  defaultSystemPrompt,
) {
  // Unresolved request tracking is bounded without eviction. Unlike refusal-map
  // overflow, this capacity block recovers when a pending decision settles, not
  // merely when new direct input clears the authorization epoch.
  {
    const h = registeredHarness();
    h.live("Inspect many independent status targets.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers());
    };
    let first;
    for (let i = 0; i < 256; i++) {
      const details = h.call(`pending-${i}`, `git status -- path-${i}`);
      first ??= details;
      const verdict = await h.authorize(details);
      assert.equal(verdict.kind, "allow", `pending fixture ${i}`);
    }
    check(
      "pending overflow fails closed",
      (await h.authorize(h.call("pending-overflow", "git status -- overflow"))).kind,
      "deny",
    );
    check("pending overflow does not call model", fetchCalls, 256);
    h.live("Authorize another independent inspection.");
    check(
      "new direct input does not discard unresolved outcomes",
      (await h.authorize(h.call("pending-still-full"))).kind,
      "deny",
    );
    h.decide(first, "allow", "authorizer_allowed");
    check(
      "settled pending outcome frees capacity without another direct input",
      await h.authorize(h.call("pending-capacity-freed")),
      { kind: "allow" },
    );
    check("capacity recovery reaches reviewer", fetchCalls, 257);
  }

  // Independent judge backpressure. Lanes do not share a counter: eight distinct
  // forwarded reviews and four root reviews may be outstanding together. A ninth
  // distinct forwarded packet, and a fifth distinct root packet, defer
  // review_overloaded with no model call. An identical in-flight digest coalesces.
  // Releasing one review admits one later packet in that lane only. Held
  // transports are synthetic — no network and no live judge. Do not satisfy this
  // by raising MAX_CONCURRENT_REVIEWS.
  {
    const h = registeredHarness({ mode: "enforce-subagents" });
    h.live("Inspect repository status with the worker.");
    const factsKey = Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts");
    const previousFacts = globalThis[factsKey];
    const profile = "editor";
    const definitionDigest = createHash("sha256")
      .update(readFileSync(join(offlineAgentDir, "agents", `${profile}.md`)))
      .digest("hex");
    const childSessionId = `${h.ctx.sessionManager.getSessionId()}-capacity`;
    const taskPrompt = "Inspect repository status.";
    const identity = {
      owner_id: h.ctx.sessionManager.getSessionId(),
      generation: "fixture-generation",
      agent_id: `${childSessionId}-agent`,
      run_id: `${childSessionId}-run`,
    };
    const toolCalls = {},
      requestTools = {};
    globalThis[factsKey] = new Map([
      [
        childSessionId,
        {
          parentSessionId: identity.owner_id,
          cwd: h.ctx.cwd,
          contextChanged: false,
          initialPromptDigest: hashJson(taskPrompt),
          harness: {
            ...identity,
            protocol: 1,
            profile,
            definitionDigest,
            task_prompt: taskPrompt,
            prompt: taskPrompt,
            systemPrompt: defaultSystemPrompt(),
          },
          toolCalls,
          requestTools,
        },
      ],
    ]);
    h.bus.get("pi-harness:approval:admitted")(identity);
    h.bus.get("pi-harness:approval:started")({ sessionId: childSessionId });

    const held = [];
    const inflight = [];
    let fetchCalls = 0;
    let holdTransports = true;
    let transportError;
    let fetchNotify = () => {};
    const commandFrom = (init) => {
      let body;
      try {
        body = JSON.parse(init.body);
      } catch (error) {
        throw new Error(`review transport body is not JSON: ${error.message}`);
      }
      const action = body?.state?.exactAction;
      const command = action?.currentToolCall?.arguments?.command ?? action?.gateRequest?.value;
      if (typeof command !== "string") {
        throw new Error(
          `review transport missing exact command (body keys: ${Object.keys(body ?? {}).join(",")}; state keys: ${Object.keys(body?.state ?? {}).join(",")})`,
        );
      }
      return command;
    };
    globalThis.fetch = async (_url, init) => {
      fetchCalls += 1;
      let command;
      try {
        command = commandFrom(init);
      } catch (error) {
        transportError = error;
        fetchNotify();
        throw error;
      }
      fetchNotify();
      if (!holdTransports) return mockResponse(allowAnswers());
      await new Promise((resolve) => {
        held.push({ command, resolve });
      });
      return mockResponse(allowAnswers());
    };
    const waitUntil = async (predicate, label) => {
      const deadline = Date.now() + 1_000;
      while (!predicate()) {
        if (transportError) throw transportError;
        if (Date.now() >= deadline)
          assert.fail(`${label} (${fetchCalls} transports, ${held.length} held)`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 10);
          fetchNotify = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    };
    const within = async (promise, label) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const start = (details) => {
      const promise = h.authorize(details);
      inflight.push(promise);
      return promise;
    };
    const forwarded = (id, command) => {
      const details = h.call(id, command);
      h.branch.pop();
      const toolCallId = details.toolCallId;
      delete details.toolCallId;
      details.agentName = profile;
      details.forwarding = { requesterSessionId: childSessionId, requesterAgentName: profile };
      details.payload.request.requester = {
        forwarded: true,
        sessionId: childSessionId,
        agentName: profile,
      };
      details.accessIntent = { surface: "bash", matchValues: [command] };
      toolCalls[toolCallId] = { name: "bash", arguments: { command } };
      requestTools[details.requestId] = toolCallId;
      return details;
    };
    const commandFor = (lane, id) => `git status -- capacity-${lane}-${id}`;
    const releaseCommand = async (command) => {
      await waitUntil(
        () => held.some((entry) => entry.command === command),
        `missing held review ${command}`,
      );
      held
        .splice(
          held.findIndex((entry) => entry.command === command),
          1,
        )[0]
        .resolve();
    };
    const expectOverload = async (label, details, scope) => {
      const before = fetchCalls;
      const verdict = await within(start(details), label);
      const audit = h.reviews.at(-1);
      check(
        label,
        {
          verdict,
          requestScope: audit.requestScope,
          failureCode: audit.failureCode,
          modelCalled: audit.modelCalled,
          transports: fetchCalls - before,
        },
        {
          verdict: { kind: "defer" },
          requestScope: scope,
          failureCode: "review_overloaded",
          modelCalled: false,
          transports: 0,
        },
      );
    };
    const releaseAll = () => {
      holdTransports = false;
      for (const entry of held.splice(0)) entry.resolve();
    };

    try {
      const auditAt = h.reviews.length;
      const subCommands = [],
        subPromises = [];
      for (let i = 0; i < 8; i++) {
        const command = commandFor("sub", i);
        subCommands.push(command);
        subPromises.push(start(forwarded(`sub-${i}`, command)));
      }
      const ninth = start(forwarded("sub-ninth", commandFor("sub", "ninth")));
      const subTwin = start(forwarded("sub-0-twin", subCommands[0]));
      const rootCommands = [],
        rootDetails = [],
        rootPromises = [];
      for (let i = 0; i < 4; i++) {
        const command = commandFor("root", i);
        const details = h.call(`root-${i}`, command);
        rootCommands.push(command);
        rootDetails.push(details);
        rootPromises.push(start(details));
      }
      const rootTwinDetails = structuredClone(rootDetails[3]);
      rootTwinDetails.requestId = `${rootTwinDetails.requestId}-twin`;
      const rootTwin = start(rootTwinDetails);
      const fifthRoot = start(h.call("root-fifth", commandFor("root", "fifth")));
      let subTwinSettled = false,
        rootTwinSettled = false;
      subTwin.then(
        () => {
          subTwinSettled = true;
        },
        () => {
          subTwinSettled = true;
        },
      );
      rootTwin.then(
        () => {
          rootTwinSettled = true;
        },
        () => {
          rootTwinSettled = true;
        },
      );
      if (transportError) throw transportError;
      check(
        "distinct packets beyond each lane cap defer review_overloaded without a model call",
        h.reviews.slice(auditAt).map((row) => ({
          requestScope: row.requestScope,
          failureCode: row.failureCode,
          modelCalled: row.modelCalled,
          effectiveVerdict: row.effectiveVerdict,
        })),
        [
          {
            requestScope: "subagent",
            failureCode: "review_overloaded",
            modelCalled: false,
            effectiveVerdict: "defer",
          },
          {
            requestScope: "root",
            failureCode: "review_overloaded",
            modelCalled: false,
            effectiveVerdict: "defer",
          },
        ],
      );
      check(
        "excess distinct packets defer to the human",
        await Promise.all([
          within(ninth, "ninth forwarded packet"),
          within(fifthRoot, "fifth root packet"),
        ]),
        [{ kind: "defer" }, { kind: "defer" }],
      );
      await Promise.resolve();
      check(
        "identical digests do not defer as overloaded while their packet is in flight",
        [subTwinSettled, rootTwinSettled],
        [false, false],
      );
      await waitUntil(() => held.length >= 12, "twelve distinct reviews were not held");
      check(
        "eight forwarded and four root reviews are outstanding",
        held.map((entry) => entry.command).sort(),
        [...subCommands, ...rootCommands].sort(),
      );
      check(
        "coalesced digests share one transport",
        [
          held.filter((entry) => entry.command === subCommands[0]).length,
          held.filter((entry) => entry.command === rootCommands[3]).length,
          fetchCalls,
        ],
        [1, 1, 12],
      );
      check(
        "coalesced reviews stay outstanding after transport admission",
        [subTwinSettled, rootTwinSettled],
        [false, false],
      );

      await releaseCommand(subCommands[1]);
      check(
        "released forwarded review allows",
        await within(subPromises[1], "released forwarded review"),
        { kind: "allow" },
      );
      await expectOverload(
        "root cap stays full after a subagent release",
        h.call("root-still", commandFor("root", "still")),
        "root",
      );
      const laterSubCommand = commandFor("sub", "later");
      const laterSub = start(forwarded("sub-later", laterSubCommand));
      await waitUntil(
        () => held.some((entry) => entry.command === laterSubCommand),
        "later forwarded packet was not admitted",
      );
      check("releasing one forwarded review admits one later distinct packet", fetchCalls, 13);
      await expectOverload(
        "the freed subagent slot is only one review",
        forwarded("sub-probe", commandFor("sub", "probe")),
        "subagent",
      );

      await releaseCommand(rootCommands[0]);
      check("released root review allows", await within(rootPromises[0], "released root review"), {
        kind: "allow",
      });
      await expectOverload(
        "root release does not free the full subagent lane",
        forwarded("sub-after-root", commandFor("sub", "after-root")),
        "subagent",
      );
      const laterRootCommand = commandFor("root", "later");
      const laterRoot = start(h.call("root-later", laterRootCommand));
      await waitUntil(
        () => held.some((entry) => entry.command === laterRootCommand),
        "later root packet was not admitted",
      );
      check("releasing one root review admits one later distinct packet", fetchCalls, 14);
      await expectOverload(
        "the freed root slot is only one review",
        h.call("root-probe", commandFor("root", "probe")),
        "root",
      );

      const transportsBeforeCoalesce = fetchCalls;
      await releaseCommand(subCommands[0]);
      check(
        "coalesced forwarded review allows",
        await within(subPromises[0], "coalesced forwarded original"),
        { kind: "allow" },
      );
      check(
        "identical forwarded digest resolves with that outstanding review",
        await within(subTwin, "coalesced forwarded twin"),
        { kind: "allow" },
      );
      await releaseCommand(rootCommands[3]);
      check(
        "coalesced root review allows",
        await within(rootPromises[3], "coalesced root original"),
        { kind: "allow" },
      );
      check(
        "identical root digest resolves with that outstanding review",
        await within(rootTwin, "coalesced root twin"),
        { kind: "allow" },
      );
      check(
        "coalesced completions do not open another transport",
        fetchCalls,
        transportsBeforeCoalesce,
      );

      releaseAll();
      const finished = await Promise.all(
        [...subPromises, ...rootPromises, laterSub, laterRoot].map((promise) =>
          within(promise, "admitted capacity review"),
        ),
      );
      check(
        "every admitted capacity review allows",
        finished.map((result) => result.kind),
        finished.map(() => "allow"),
      );
    } finally {
      releaseAll();
      await Promise.allSettled(inflight);
      if (previousFacts === undefined) delete globalThis[factsKey];
      else globalThis[factsKey] = previousFacts;
      globalThis.fetch = async () => {
        throw new Error("Network disabled during offline Jev checks");
      };
    }
  }

  {
    const h = registeredHarness({ hasUI: false });
    globalThis.fetch = async () => {
      throw new Error("Headless asks must not invoke the reviewer");
    };
    for (let i = 0; i <= 256; i++) {
      assert.deepEqual(await h.authorize(h.call(`headless-${i}`)), { kind: "defer" });
    }
    check(
      "headless overflow preserves its defer reason",
      h.reviews.at(-1).failureCode,
      "headless_session",
    );
  }
}
