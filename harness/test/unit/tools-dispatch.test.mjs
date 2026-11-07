import {
  code,
  viewOf,
  settle,
  toolsFor,
  create,
  run,
  quickstartFlows,
} from "../support/owner-tools-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createChildTools } from "../../dist/tools/child-tools.js";
import { FakePort, fixture, until } from "../support/controller-fixture.mjs";

test("spawn and reuse dispatch relative paths from the inherited parent cwd", async (t) => {
  const port = new FakePort();
  let creates = 0,
    prepares = 0,
    observedTree;
  const contexts = [];
  const dispatch = {
    prepare(declaration, context) {
      prepares++;
      contexts.push(context);
      const path = (word) => ({
        path: resolve(context.cwd, word),
        canonical: resolve(context.cwd, word),
      });
      return {
        declaration: structuredClone(declaration),
        inputs: [],
        ownership: [],
        ...(declaration.tree === undefined ? {} : { tree: path(declaration.tree) }),
      };
    },
    async start(prepared, context) {
      observedTree = prepared.tree.path;
      contexts.push(context);
      return {};
    },
  };
  const f = await fixture(t, {
    controller: {
      createSession: async () => {
        creates++;
        return port;
      },
      dispatch,
    },
    beforeShutdown: () => {
      if (port.streaming) port.finish("cleanup", "aborted");
    },
  });
  const { tool, call } = toolsFor(f),
    args = create({ agent: "wren", dispatch: { tree: "build" } });
  assert.deepEqual(tool("agent_spawn").prepareArguments(args), args);
  assert.equal(creates, 0);
  assert.equal(prepares, 0, "schema preparation does no dispatch IO");
  const first = await call("agent_spawn", args, "first-spawn");
  assert.deepEqual(first.action, { type: "agent_spawn", agent: "wren", task: 1 });
  await until(() => port.streaming);
  assert.equal(viewOf(f, "wren").effective_settings.cwd, "/tmp");
  assert.equal(observedTree, "/tmp/build");
  assert.equal(prepares, 2, "admission and pump recheck");
  port.finish();
  await settle(f, "wren");
  const follow = await call(
    "agent_run",
    run("wren", { dispatch: { tree: "build" } }),
    "tree-followup",
  );
  assert.deepEqual(follow.action, { type: "agent_run", agent: "wren", task: 2 });
  await until(() => port.calls.length === 2);
  assert.equal(creates, 1);
  assert(contexts.every((context) => context.cwd === "/tmp" && context.profile === "editor"));
  for (const context of contexts)
    assert.deepEqual(
      Object.keys(context).sort(),
      [
        "cwd",
        "profile",
        Object.hasOwn(context, "deferInputs") ? "deferInputs" : "acquireTree",
      ].sort(),
    );
  port.finish();
  await settle(f, "wren");
  assert.deepEqual(await call("agent_kill", { agent: "wren" }), {
    agent: "wren",
    status: "killed",
    label: "task",
  });
  assert.equal(
    (await call("agent_read", { agent: "wren", task: 1 })).agents[0].status,
    "completed",
  );
});

assert.equal(
  quickstartFlows.length,
  4,
  "all four documented workflows have executable call examples",
);

for (const [flowIndex, steps] of quickstartFlows.entries())
  test(`quickstart workflow ${flowIndex + 1} uses registered tools and actual returned identities`, async (t) => {
    const dispatchPort = new FakePort(),
      starts = [];
    dispatchPort.autoStop = true;
    const dispatch = {
      prepare(declaration, context) {
        const path = (word) => ({
          path: resolve(context.cwd, word),
          canonical: resolve(context.cwd, word),
        });
        return {
          declaration: structuredClone(declaration),
          inputs: (declaration.inputs ?? []).map(path),
          ownership: (declaration.ownership ?? []).map(path),
          ...(declaration.tree ? { tree: path(declaration.tree) } : {}),
        };
      },
      async start(prepared, context) {
        starts.push({ prepared, context });
        return {};
      },
    };
    const f = await fixture(
      t,
      flowIndex === 3
        ? {
            controller: { dispatch, createSession: async () => dispatchPort },
            beforeShutdown: () => {
              if (dispatchPort.streaming) dispatchPort.finish("cleanup", "aborted");
            },
          }
        : { controller: { concurrency: 2 } },
    );
    const { call, tool } = toolsFor(f);
    let questionId,
      cursor,
      firstPage,
      waits = 0;
    const oldResult = "retained first-task evidence ".repeat(20);
    for (const [stepIndex, step] of steps.entries()) {
      const args = structuredClone(step.arguments);
      if (args.question_id === "<INVALID_QUESTION_ID>") {
        assert.throws(() => tool(step.tool).prepareArguments(args), code("INVALID_PARAMETERS"));
        assert.match(questionId, /^q_[0-9a-f]{32}$/);
        args.question_id = questionId;
      }
      if (args.cursor === "<INVALID_RESULT_CURSOR>") {
        // Cursors are opaque at schema level; runtime rejects the deliberately invalid placeholder.
        await assert.rejects(
          call(step.tool, args, `invalid-cursor-${flowIndex}`),
          code("INVALID_CURSOR"),
        );
        assert.match(cursor, /^r1_/);
        args.cursor = cursor;
      }
      assert.deepEqual(
        tool(step.tool).prepareArguments(args),
        args,
        "examples match the actual closed schema",
      );
      if (step.tool === "agent_wait") {
        waits++;
        if (flowIndex === 0) {
          await until(() => f.ports.length === 2 && f.ports.every((port) => port.streaming));
          f.ports[0].finish("parser findings");
          f.ports[1].finish("documentation findings");
          await settle(f, "alpha");
          await settle(f, "beta");
        } else if (flowIndex === 1 && waits === 1) {
          await until(() => f.ports[0]?.streaming);
          const port = f.ports[0],
            child = createChildTools(() => port.callbacks, { accepting: true, stopped: false });
          const ask = child.find((item) => item.name === "ask_parent");
          assert.match(ask.description, /stop calling tools and end your turn/);
          const receipt = await ask.execute("ask", { question: "Which format?" });
          assert.match(receipt.content[0].text, /Stop calling tools and end your turn/);
          await ask.execute("second-ask", { question: "Not a replacement" });
          assert.equal(
            port.streaming,
            true,
            "ask records a question; it does not force suspension",
          );
          assert.equal(
            viewOf(f, "alpha").question_id,
            undefined,
            "no actionable token before settlement",
          );
          port.finish("waiting for the required choice");
          await settle(f, "alpha");
        } else if (flowIndex === 1) {
          await until(() => f.ports[0].streaming);
          assert.equal(f.ports.length, 1, "fixed after dependency has not started beta early");
          f.ports[0].finish("compatible parser change");
          await settle(f, "alpha");
          await until(() => f.ports[1]?.streaming);
          assert.match(
            f.ports[1].calls[0].prompt,
            /compatible parser change/,
            "after supplies real continuation output",
          );
          f.ports[1].finish("review findings");
          await settle(f, "beta");
        } else if (flowIndex === 2) {
          await until(() => f.ports[0]?.streaming);
          f.ports[0].finish(waits === 1 ? oldResult : "latest result");
          await settle(f, "alpha");
        } else {
          await until(() => dispatchPort.streaming);
          assert.equal(starts.length, 1);
          assert.equal(starts[0].context.cwd, "/tmp");
          assert.equal(starts[0].prepared.inputs[0].path, "/tmp/src/parser.ts");
          assert.equal(starts[0].prepared.ownership[0].path, "/tmp/src/parser.ts");
          assert.equal(starts[0].prepared.tree.path, "/tmp/build");
          assert.match(dispatchPort.calls[0].prompt, /Execution cwd: "\/tmp"/);
          dispatchPort.finish("synthetic assigned check report; no real parser check executed");
          await settle(f, "alpha");
        }
      }
      const reply = await call(step.tool, args, `quickstart-${flowIndex}-${stepIndex}`);
      if (flowIndex === 0 && step.tool === "agent_read") {
        assert.equal(reply.agents[0].status, "completed");
        assert.equal(
          reply.agents[0].result,
          args.agent === "alpha" ? "parser findings" : "documentation findings",
        );
      }
      if (flowIndex === 1 && step.tool === "agent_wait" && waits === 1) {
        assert.equal(reply.agents[0].status, "needs_input");
        assert.equal(reply.agents[0].question, "Which format?");
        questionId = reply.agents[0].question_id;
      }
      if (flowIndex === 1 && step.tool === "agent_answer") assert.equal(reply.action.task, 2);
      if (flowIndex === 1 && step.tool === "agent_spawn" && args.after)
        assert.equal(reply.agents[0].status, "queued");
      if (flowIndex === 2 && step.tool === "agent_read" && args.task) {
        assert.equal(reply.agents[0].task, 1);
        firstPage = reply.agents[0].result;
        cursor = reply.agents[0].next_cursor;
      } else if (flowIndex === 2 && step.tool === "agent_read") {
        assert.equal(reply.agents[0].task, 1);
        assert.equal(firstPage + reply.agents[0].result, oldResult);
        assert.equal(reply.agents[0].next_cursor, undefined);
      }
      if (flowIndex === 3 && step.tool === "agent_read")
        assert.equal(reply.agents[0].status, "completed");
    }
  });
