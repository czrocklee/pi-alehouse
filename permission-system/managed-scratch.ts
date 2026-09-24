import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { getPermissionsService } from "./node_modules/@gotgenes/pi-permission-system/src/service.ts";
import type { ManagedScratchRoot } from "./node_modules/@gotgenes/pi-permission-system/src/access-intent/bash/managed-read-policy.ts";

const ENTRY_TYPE = "managed-scratch-created";
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_LINES = 10_000;
const CLOCK_SLOP_NS = 2_000_000_000n;

type ScratchRecord = ManagedScratchRoot & {
  readonly version: 1;
  readonly sessionId: string;
  readonly observedAt: number;
};

type Pending = {
  readonly sessionId: string;
  readonly input: Record<string, unknown>;
  readonly startedAtNs: bigint;
};

type Harden = (
  input: Record<string, unknown>,
  roots: readonly ManagedScratchRoot[],
  cwd: string,
) => Promise<{ version: 1; originalDigest: string; executionDigest: string } | undefined>;

function rootRecord(value: unknown, expectedSession: string): ScratchRecord | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || item.sessionId !== expectedSession ||
      typeof item.path !== "string" || typeof item.dev !== "string" || typeof item.ino !== "string" ||
      typeof item.uid !== "number" || typeof item.birthtimeNs !== "string" || typeof item.observedAt !== "number") return;
  if (!/^\/tmp\/tmp\.[A-Za-z0-9]+$/.test(item.path)) return;
  return item as ScratchRecord;
}

function secureDirectory(path: string, euid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === euid && (stat.mode & 0o022) === 0;
  } catch { return false; }
}

function protectedJournal(path: string, ctx: ExtensionContext): boolean {
  const euid = process.geteuid?.();
  if (euid === undefined) return false;
  const sessions = resolve(homedir(), ".pi/agent/sessions");
  let realSessions: string;
  let realPath: string;
  try {
    for (const directory of [resolve(homedir(), ".pi"), resolve(homedir(), ".pi/agent")])
      if (!secureDirectory(directory, euid) || (lstatSync(directory).mode & 0o777) !== 0o700) return false;
    if (!secureDirectory(sessions, euid)) return false;
    realSessions = realpathSync(sessions);
    realPath = realpathSync(path);
  } catch { return false; }
  // Do not authenticate an arbitrary writable session path through an alias
  // that happens to point at a protected journal at inspection time.
  if (realSessions !== sessions || realPath !== path) return false;
  const rel = relative(realSessions, realPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  let directory = dirname(realPath);
  while (directory !== realSessions) {
    if (!secureDirectory(directory, euid)) return false;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  try {
    const stat = lstatSync(realPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== euid || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) return false;
  } catch { return false; }
  const service = getPermissionsService(ctx.sessionManager.getSessionId());
  const agentName = activeAgent(ctx);
  return service?.checkPermission("path_write", realPath, agentName).state === "deny";
}

function activeAgent(ctx: ExtensionContext): string | undefined {
  for (const entry of ctx.sessionManager.getBranch().reverse()) {
    if (entry.type !== "custom" || entry.customType !== "active_agent") continue;
    const name = (entry.data as { name?: unknown } | undefined)?.name;
    if (typeof name === "string") return name;
  }
}

function readJournal(path: string): unknown[] | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) return;
    // Read only the size that was checked, even if the parent keeps appending.
    // An in-flight trailing JSONL record is not evidence; ignore it entirely.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    const newline = text.lastIndexOf("\n");
    if (newline < 0) return;
    const lines = text.slice(0, newline).split("\n").filter(Boolean);
    if (lines.length === 0 || lines.length > MAX_JOURNAL_LINES) return;
    return lines.map(line => JSON.parse(line));
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function recordsFromEntries(entries: readonly unknown[], expectedSession: string): ScratchRecord[] {
  const records: ScratchRecord[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== ENTRY_TYPE) continue;
    const record = rootRecord(item.data, expectedSession);
    if (record) records.push(record);
  }
  return records;
}

function sessionStemMatches(stem: string, id: string): boolean {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return false;
  if (stem === id) return true;
  const suffix = `_${id}`;
  return stem.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}T[\d:.-]+Z?$/.test(stem.slice(0, -suffix.length));
}

function parentJournal(currentFile: string, declaredParent: string, currentSession: string): string | undefined {
  if (basename(dirname(currentFile)) !== "tasks" || !currentFile.endsWith(".jsonl") ||
      !sessionStemMatches(basename(currentFile, ".jsonl"), currentSession)) return;
  const parentStem = dirname(dirname(currentFile));
  if (!sessionStemMatches(basename(parentStem), declaredParent)) return;
  return `${parentStem}.jsonl`;
}

function rootFromResult(text: string, sessionId: string, startedAtNs: bigint): ScratchRecord | undefined {
  if (!/^\/tmp\/tmp\.[A-Za-z0-9]+\n?$/.test(text)) return;
  const path = text.endsWith("\n") ? text.slice(0, -1) : text;
  try {
    const stat = lstatSync(path, { bigint: true });
    const euid = process.geteuid?.();
    if (euid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== euid ||
        Number(stat.mode & 0o777n) !== 0o700 || stat.birthtimeNs <= 0n ||
        stat.birthtimeNs + CLOCK_SLOP_NS < startedAtNs || stat.birthtimeNs > BigInt(Date.now()) * 1_000_000n + CLOCK_SLOP_NS ||
        readdirSync(path).length !== 0) return;
    let current = path;
    while (true) {
      const ancestor = lstatSync(current);
      if (ancestor.isSymbolicLink()) return;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return { version: 1, sessionId, path, dev: stat.dev.toString(), ino: stat.ino.toString(),
      uid: euid, birthtimeNs: stat.birthtimeNs.toString(), observedAt: Date.now() };
  } catch { return; }
}

/** Install process-observed mktemp provenance and the bounded static file lane. */
export function installManagedScratch(pi: ExtensionAPI, harden: Harden): void {
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let header: ReturnType<ExtensionContext["sessionManager"]["getHeader"]> | undefined;
  let loadedPersisted = false;
  const roots = new Map<string, ScratchRecord>();
  const pending = new Map<string, Pending>();

  const loadPersisted = (ctx: ExtensionContext) => {
    if (loadedPersisted) return;
    loadedPersisted = true;
    if (!sessionId || !sessionFile || !header || !protectedJournal(sessionFile, ctx)) return;
    for (const record of recordsFromEntries(ctx.sessionManager.getEntries(), sessionId)) roots.set(record.path, record);
    const declared = header.parentSession;
    if (typeof declared !== "string") return;
    const parentFile = parentJournal(sessionFile, declared, sessionId);
    if (!parentFile || !protectedJournal(parentFile, ctx)) return;
    const entries = readJournal(parentFile);
    const parentHeader = entries?.[0] as { type?: unknown; id?: unknown } | undefined;
    if (!entries || parentHeader?.type !== "session" || parentHeader.id !== declared) return;
    for (const record of recordsFromEntries(entries.slice(1), declared)) roots.set(record.path, record);
  };

  const syncSession = (ctx: ExtensionContext, reset = false) => {
    const currentId = ctx.sessionManager.getSessionId();
    const currentFile = ctx.sessionManager.getSessionFile();
    if (!reset && sessionId === currentId && sessionFile === currentFile) return;
    sessionId = currentId;
    sessionFile = currentFile;
    header = ctx.sessionManager.getHeader();
    loadedPersisted = false;
    roots.clear();
    pending.clear();
  };
  pi.on("session_start", (_event, ctx) => syncSession(ctx, true));
  // Also check the authoritative SDK identity on every call/result: a reused
  // runner must never retain another session's in-memory creation records.
  // Steer may bring newly created parent roots.
  pi.on("input", (_event, ctx) => { syncSession(ctx); loadedPersisted = false; });

  pi.on("tool_call", async (event, ctx) => {
    syncSession(ctx);
    if (event.toolName !== "bash" || !sessionId) return;
    if (event.input.command === "mktemp -d") {
      pending.set(event.toolCallId, { sessionId, input: event.input, startedAtNs: BigInt(Date.now()) * 1_000_000n });
      return;
    }
    loadPersisted(ctx);
    const audit = await harden(event.input, [...roots.values()], ctx.cwd);
    if (audit) pi.appendEntry("managed-static-file-effects", audit);
  });

  pi.on("tool_result", (event, ctx) => {
    syncSession(ctx);
    const item = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!item || event.toolName !== "bash" || event.isError || event.input !== item.input ||
        event.input.command !== "mktemp -d" || item.sessionId !== sessionId || event.content.length !== 1 ||
        event.content[0].type !== "text" || event.details?.truncation || event.details?.fullOutputPath) return;
    const record = rootFromResult(event.content[0].text, item.sessionId, item.startedAtNs);
    if (!record) return;
    roots.set(record.path, record);
    pi.appendEntry(ENTRY_TYPE, record);
  });

  pi.on("session_shutdown", () => {
    sessionId = undefined;
    sessionFile = undefined;
    header = undefined;
    loadedPersisted = false;
    roots.clear();
    pending.clear();
  });
}
