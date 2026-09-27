#!/usr/bin/env node
// Offline orchestration metrics for one Pi parent session JSONL file.
// Reads a local transcript only; it never contacts a model or the network and
// prints aggregates, not transcript text. Transcripts themselves are not source.
import { readFileSync } from "node:fs";

const management = new Set(["agent_spawn", "agent_run", "agent_send", "agent_wait", "agent_read",
  "agent_interrupt", "agent_kill", "agent_list"]);

function usage() {
  console.error("Usage: node scripts/analyze-pi-session.mjs [--json] <session.jsonl>");
  process.exit(2);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const file = args.find((arg) => !arg.startsWith("--"));
if (!file) usage();

const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map(parse).filter(Boolean);

const parent = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const tools = new Map();
const calls = new Map(); // toolCallId -> { name, args }
const harness = {
  spawn: { ok: 0, with_wait_ms: 0, after_agents: 0 },
  run: { ok: 0, with_wait_ms: 0, after_agents: 0 },
  send: { steered: 0, joined: 0, answered: 0, not_delivered: 0, with_wait_ms: 0 },
  errors: {},
  wait: { calls: 0, short_timeout: 0, reasons: {} },
  agent_list: 0, agent_read: 0, agent_interrupt: 0, agent_kill: 0, finished_seen: 0,
};
let childCost = 0, compactions = 0, managementOnlyTurns = 0, toolTurns = 0, userMessages = 0;

const bump = (record, key) => { record[key] = (record[key] ?? 0) + 1; };
const replyOf = (message) => {
  const text = message.content?.find?.((part) => part.type === "text")?.text;
  return typeof text === "string" ? parse(text) : undefined;
};

for (const entry of entries) {
  if (entry.type === "compaction") compactions++;
  if (entry.type !== "message") continue;
  const message = entry.message;
  if (message.role === "user") userMessages++;
  if (message.role === "assistant") {
    parent.calls++;
    const u = message.usage ?? {};
    parent.input += u.input ?? 0; parent.output += u.output ?? 0;
    parent.cacheRead += u.cacheRead ?? 0; parent.cacheWrite += u.cacheWrite ?? 0;
    parent.cost += u.cost?.total ?? 0;
    const toolCalls = (message.content ?? []).filter((part) => part.type === "toolCall");
    if (toolCalls.length) {
      toolTurns++;
      if (toolCalls.every((call) => management.has(call.name))) managementOnlyTurns++;
    }
    for (const call of toolCalls) {
      tools.set(call.name, (tools.get(call.name) ?? 0) + 1);
      calls.set(call.id, { name: call.name, args: call.arguments ?? {} });
    }
  }
  if (message.role !== "toolResult") continue;
  childCost += message.usage?.cost?.total ?? message.usage?.cost ?? 0;
  const call = calls.get(message.toolCallId);
  const name = message.toolName ?? call?.name;
  if (!management.has(name)) continue;
  const reply = replyOf(message);
  if (Array.isArray(reply?.finished)) harness.finished_seen += reply.finished.length;
  const args = call?.args ?? {};
  if (message.isError) { bump(harness.errors, `${name}:${reply?.error?.code ?? "unknown"}`); continue; }
  switch (name) {
    case "agent_spawn": case "agent_run": {
      const record = harness[name === "agent_spawn" ? "spawn" : "run"];
      record.ok++;
      if (args.wait_ms) record.with_wait_ms++;
      record.after_agents += Array.isArray(args.after) ? args.after.length : 0;
      break;
    }
    case "agent_send":
      bump(harness.send, reply?.delivery ?? "unknown");
      if (args.wait_ms) harness.send.with_wait_ms++;
      break;
    case "agent_wait":
      harness.wait.calls++;
      if (typeof args.wait_ms === "number" && args.wait_ms < 60_000) harness.wait.short_timeout++;
      bump(harness.wait.reasons, reply?.reason ?? "unknown");
      break;
    default: harness[name]++;
  }
}

const prompt = parent.input + parent.cacheRead + parent.cacheWrite;
const report = {
  file,
  user_messages: userMessages,
  compactions,
  parent: { ...parent, cost: Number(parent.cost.toFixed(4)),
    cache_hit_rate: prompt ? Number((parent.cacheRead / prompt).toFixed(4)) : null },
  child_cost_attached: Number(childCost.toFixed(4)),
  tool_turns: toolTurns,
  management_only_turns: managementOnlyTurns,
  tools: Object.fromEntries([...tools].sort((a, b) => b[1] - a[1])),
  harness,
};

if (json) console.log(JSON.stringify(report, null, 2));
else {
  const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  console.log(`session            ${file}`);
  console.log(`user messages      ${userMessages}   compactions ${compactions}`);
  console.log(`parent LLM calls   ${parent.calls}   cost $${report.parent.cost}   cache hit ${pct(report.parent.cache_hit_rate)}`);
  console.log(`child cost (attached to results) $${report.child_cost_attached}`);
  console.log(`tool turns         ${toolTurns}   management-only ${managementOnlyTurns}`);
  console.log(`agent_spawn        ${JSON.stringify(harness.spawn)}`);
  console.log(`agent_run          ${JSON.stringify(harness.run)}`);
  console.log(`agent_send         ${JSON.stringify(harness.send)}`);
  console.log(`agent_wait         ${harness.wait.calls}   wait<60s ${harness.wait.short_timeout}   reasons ${JSON.stringify(harness.wait.reasons)}`);
  console.log(`agent_list         ${harness.agent_list}   read ${harness.agent_read}   interrupt ${harness.agent_interrupt}   kill ${harness.agent_kill}   finished seen ${harness.finished_seen}`);
  console.log(`errors             ${JSON.stringify(harness.errors)}`);
  console.log("tools              " + Object.entries(report.tools).map(([k, v]) => `${k}=${v}`).join(" "));
}
