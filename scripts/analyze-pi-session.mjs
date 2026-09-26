#!/usr/bin/env node
// Offline orchestration metrics for one Pi parent session JSONL file.
// Reads a local transcript only; it never contacts a model or the network and
// prints aggregates, not transcript text. Transcripts themselves are not source.
import { readFileSync } from "node:fs";

const management = new Set(["spawn_agent", "resume_agent", "read_run", "wait_runs", "list_agents",
  "steer_run", "post_update", "cancel_run", "release_agent"]);

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
  spawn: 0, resume: 0, handoff_runs: 0, after_runs: 0, wait_ms_submits: 0,
  steer: { accepted: 0, input_closed: 0, other_error: 0 },
  post_update: { steered: 0, queued: 0, rejected: 0 },
  wait: { calls: 0, short_timeout: 0, reasons: {} },
  list_agents: 0, read_run: 0, changes_seen: 0,
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
  if (Array.isArray(reply?.changes)) harness.changes_seen += reply.changes.length;
  const args = call?.args ?? {};
  switch (name) {
    case "spawn_agent": case "resume_agent":
      harness[name === "spawn_agent" ? "spawn" : "resume"]++;
      if (args.wait_ms) harness.wait_ms_submits++;
      harness.handoff_runs += Array.isArray(args.handoff_from) ? args.handoff_from.length : 0;
      harness.after_runs += Array.isArray(args.after) ? args.after.length : 0;
      break;
    case "steer_run":
      if (reply?.accepted === true) harness.steer.accepted++;
      else if (reply?.reason === "RUN_INPUT_CLOSED" || reply?.error?.code === "RUN_INPUT_CLOSED") harness.steer.input_closed++;
      else harness.steer.other_error++;
      break;
    case "post_update":
      for (const target of reply?.targets ?? []) bump(harness.post_update, target.delivery ?? "rejected");
      break;
    case "wait_runs":
      harness.wait.calls++;
      if (typeof args.timeout_ms === "number" && args.timeout_ms < 60_000) harness.wait.short_timeout++;
      bump(harness.wait.reasons, reply?.reason ?? (message.isError ? "error" : "unknown"));
      break;
    case "list_agents": harness.list_agents++; break;
    case "read_run": harness.read_run++; break;
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
  console.log(`spawn/resume       ${harness.spawn}/${harness.resume}   with wait_ms ${harness.wait_ms_submits}   handoff runs ${harness.handoff_runs}   after runs ${harness.after_runs}`);
  console.log(`steer_run          accepted ${harness.steer.accepted}   input closed ${harness.steer.input_closed}   other error ${harness.steer.other_error}`);
  console.log(`post_update        ${JSON.stringify(harness.post_update)}`);
  console.log(`wait_runs          ${harness.wait.calls}   timeout<60s ${harness.wait.short_timeout}   reasons ${JSON.stringify(harness.wait.reasons)}`);
  console.log(`list_agents        ${harness.list_agents}   read_run ${harness.read_run}   changes seen ${harness.changes_seen}`);
  console.log("tools              " + Object.entries(report.tools).map(([k, v]) => `${k}=${v}`).join(" "));
}
