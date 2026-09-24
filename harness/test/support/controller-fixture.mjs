import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerController } from "../../dist/core/owner-controller.js";
import { FileOwnerLease } from "../../dist/runtime/owner-lease.js";
import { boundedOutput } from "../../dist/core/result-text.js";
import { flock } from "./flock.mjs";

export const deferred = () => Promise.withResolvers();
export const settings = { provider: "fixture", model: "controlled", thinking: "off", parent_thinking: "off",
  thinking_resolution: "identity", profile: "reader",
  difficulty: 3, strength: "standard", preset: "fixture", preset_version: "v1", selection_digest: "2".repeat(64),
  cwd: "/tmp", tools: ["read"], definition_digest: "1".repeat(64) };
export const task = (prompt, rest = {}) => ({ prompt, description: prompt, settings, ...rest });
export const errorCode = (code) => (error) => error.code === code;
export class FakePort {
  session_id = randomUUID();
  calls = [];
  inputs = [];
  stopped = 0;
  disposed = 0;
  streaming = false;
  async run(prompt, callbacks) {
    const done = deferred();
    this.callbacks = callbacks; this.streaming = true;
    this.calls.push({ prompt, done });
    callbacks.inputEntered(); callbacks.turnStart();
    try { return await done.promise; } finally { this.streaming = false; }
  }
  canInput() { return this.streaming; }
  finish(text = "done", kind = "success", error, model_stop_reason) {
    this.callbacks.output(boundedOutput(text, 1_048_576)); this.callbacks.turnEnd();
    this.calls.at(-1).done.resolve({ kind, error, model_stop_reason, output: boundedOutput(text, 1_048_576) });
  }
  async steer(message, valid) {
    await this.deliveryGate?.promise;
    if (!valid()) return false;
    this.inputs.push(message); return true;
  }
  async stop() { this.stopped++; if (this.autoStop) this.finish("partial", "aborted"); }
  clearInputs() { return this.inputs.splice(0); }
  async dispose() { this.disposed++; return { shutdownExited: true, errors: [] }; }
}
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-p1-core-"));
  const owner_id = options.owner_id ?? randomUUID();
  const ports = [];
  const events = [];
  const owner = await FileOwnerLease.open({ directory, owner_id, flock });
  const controller = await OwnerController.open({ owner, concurrency: 1, resident_limit: 8, queue_limit: 16,
    createSession: async () => {
      const port = new FakePort(); ports.push(port);
      if (options.history) port.history = {
        begin: async (run) => { await options.history("begin", run); return { ...run, session_id: port.session_id, start_entry_id: "aaaaaaaa" }; },
        finish: async (ref, record, output) => { await options.history("finish", record, output); return { ...ref, end_entry_id: "bbbbbbbb" }; },
      };
      return port;
    },
    onContextChange: (event) => { events.push(event); }, ...options.controller });
  t.after(async () => {
    for (const port of ports) { port.deliveryGate?.resolve(); if (port.streaming) port.finish("test cleanup", "aborted"); }
    const report = await controller.shutdown(1000);
    if (!report.closed) {
      if (!options.cleanupUncertainExpected || !report.cleanup_uncertain || report.active || report.finalizing || report.cleaning || ports.some((p) => p.streaming)) {
        throw new Error(`fixture retained owner: ${JSON.stringify(report)}`);
      }
      // Test-only cleanup of a simulated uncertain report, with no live child.
      // The controller is required to REFUSE unlocking in the assertions.
      owner.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { controller, owner, directory, owner_id, ports, events };
}
export async function tick() { await new Promise((resolve) => setImmediate(resolve)); }
export async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("fixture condition timed out");
    await tick();
  }
}
export const ended = (controller, run) => controller.wait([run.run_id], { mode: "all", timeout_ms: 3000 });
