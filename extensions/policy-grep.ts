/** Search failures must not prevent the independent Bash/path guard loading. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGrepToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionsService } from "@gotgenes/pi-permission-system";
import { activeAgent, policyGrepRegistry } from "./static-safety-guard.ts";

const FILE_BYTES = 2 * 1024 * 1024;
const BATCH_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 256 * 1024 * 1024;
const RESULT_BYTES = 50 * 1024;
const MAX_FILES = 100_000;
const WORK_MS = 30_000;

function inside(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Search aborted or exceeded its shared 30 second work budget");
}

// Each subprocess shares the operation's signal/deadline. Captured file contents
// go through stdin; rg never reopens a checked pathname or reads a growing file.
async function runGrep(args: string[], cwd: string, signal: AbortSignal, input = Buffer.alloc(0), maxBytes = 8 * 1024 * 1024): Promise<{ output: string; limited: boolean }> {
  aborted(signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn("rg", ["--no-config", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: Error | undefined;
    let limited = false;
    const onAbort = () => { failure = new Error("Search aborted or exceeded its shared 30 second work budget"); child.kill("SIGKILL"); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      const available = maxBytes - bytes;
      if (available > 0) { chunks.push(chunk.subarray(0, available)); bytes += Math.min(chunk.length, available); }
      if (chunk.length > available) { limited = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") { failure = error; child.kill("SIGKILL"); }
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (!limited && code !== 0 && code !== 1) reject(new Error(`ripgrep failed: ${stderr || code}`));
      else resolveResult({ output: Buffer.concat(chunks).toString("utf8"), limited });
    });
    child.stdin.end(input);
  });
}

type Segment = { path: string; first: number; lines: number; bytes: Buffer };

function registerPolicyGrep(pi: ExtensionAPI): () => boolean {
  const original = createGrepToolDefinition(process.cwd());
  // Pi exposes the winning tool's schema by reference, including SDK custom
  // overrides. Own a unique schema so merely running this factory proves nothing.
  const parameters = { ...original.parameters };
  pi.registerTool({
    ...original,
    parameters,
    description: "Search permitted text files recursively. Directory searches skip .git, node_modules, symlinks, binary files, files over 2 MiB and deny/ask descendants. Ignore-files are not read; narrow with path/glob. Results describe exclusions and limits.",
    promptSnippet: "Search permitted project text files recursively",
    async execute(_toolCallId, params, outerSignal, _onUpdate, ctx) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), WORK_MS);
      const signal = outerSignal ? AbortSignal.any([outerSignal, abort.signal]) : abort.signal;
      const skipped = { permission: 0, tooLarge: 0, binary: 0, unavailable: 0, symlink: 0 };
      let searched = 0;
      let inputBytes = 0;
      let matches = 0;
      let outputBytes = 0;
      let incomplete = false;
      let resultLimitReached = false;
      const output: string[] = [];
      try {
        aborted(signal);
        if (process.platform !== "linux") throw new Error("Permission-aware grep requires Linux");
        const cwd = resolve(ctx.cwd);
        const canonicalCwd = await realpath(cwd);
        const input = params.path || ".";
        if (/^@?file:/i.test(input.trimStart())) throw new Error("Use a filesystem path, not a file: URL");
        const root = resolve(cwd, input.startsWith("~/") ? join(homedir(), input.slice(2)) : input);
        const canonicalRoot = await realpath(root);
        const directory = (await stat(root)).isDirectory();
        const services = (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-permission-system:session-services")];
        const service = services instanceof Map ? services.get(ctx.sessionManager.getSessionId()) as PermissionsService | undefined : undefined;
        if (!service) throw new Error("Search requires the session permission service");
        const agent = activeAgent(ctx);
        const permitted = (path: string): boolean => {
          const read = service.checkPermission("path_read", path, agent).state;
          // An explicit file has already passed its own upstream gates, including
          // a possible one-time ask grant. Never apply that grant to descendants.
          if (read === "deny" || (directory && read !== "allow")) return false;
          if (inside(path, cwd) || inside(path, canonicalCwd)) return true;
          const external = service.checkPermission("external_directory_read", path, agent).state;
          return external !== "deny" && (!directory || external === "allow");
        };
        const limit = Math.max(1, Math.min(500, Math.floor(Number.isFinite(params.limit) ? params.limit! : 100)));
        const context = Math.max(0, Math.min(10, Math.floor(Number.isFinite(params.context) ? params.context! : 0)));
        const flags = ["--json", "--color=never"];
        if (params.ignoreCase) flags.push("--ignore-case");
        if (params.literal) flags.push("--fixed-strings");
        if (context) flags.push("--context", String(context));
        await runGrep([...flags, "--", params.pattern, "-"], canonicalCwd, signal);
        let names = [canonicalRoot];
        if (directory) {
          const listing = ["--files", "--null", "--hidden", "--no-ignore", "--sort", "path"];
          if (params.glob) listing.push("--glob", params.glob);
          listing.push("--glob", "!.git", "--glob", "!node_modules", "--", canonicalRoot);
          const listed = await runGrep(listing, canonicalCwd, signal);
          names = listed.output.slice(0, listed.output.lastIndexOf("\0") + 1).split("\0").filter(Boolean);
          incomplete = listed.limited || names.length > MAX_FILES;
          names = names.slice(0, MAX_FILES);
        }
        let batch: Segment[] = [];
        let batchBytes = 0;
        let nextLine = 1;
        const readBuffer = Buffer.allocUnsafe(FILE_BYTES + 1);
        const flush = async () => {
          if (!batch.length) return;
          const result = await runGrep([...flags, "--max-count", String(Math.max(1, limit + 1 - matches)), "--", params.pattern, "-"], canonicalCwd, signal,
            Buffer.concat(batch.map((file) => file.bytes), batchBytes));
          incomplete ||= result.limited;
          searched += batch.length;
          const records: Array<{ file: Segment; number: number; match: boolean; text: string }> = [];
          let index = 0;
          for (const line of result.output.split("\n")) {
            if (!line) continue;
            let event;
            try { event = JSON.parse(line); } catch {
              if (result.limited) { incomplete = true; break; }
              throw new Error("Invalid ripgrep JSON result");
            }
            if (event.type !== "match" && event.type !== "context") continue;
            const number = event.data?.line_number;
            if (!Number.isInteger(number)) throw new Error("Missing ripgrep line number");
            while (index < batch.length && number >= batch[index].first + batch[index].lines) index += 1;
            const file = batch[index];
            if (!file || number < file.first) throw new Error("Invalid search source mapping");
            if (event.type === "match") matches += 1;
            if (matches > limit) { incomplete = true; break; }
            const raw = event.data.lines?.text ?? (event.data.lines?.bytes ? Buffer.from(event.data.lines.bytes, "base64").toString("utf8") : "");
            const text = raw.replace(/\r?\n$/, "");
            records.push({ file, number, match: event.type === "match", text });
          }
          // Context from the combined stdin stream must never cross a file
          // boundary, even when the previous file ends next to a match.
          const matched = records.filter((record) => record.match);
          const visible = records.filter(({ file, number, match }) =>
            match || matched.some((hit) => hit.file === file && Math.abs(hit.number - number) <= context));
          for (let index = 0; index < visible.length;) {
            const file = visible[index]!.file;
            const group: string[] = [];
            while (index < visible.length && visible[index]!.file === file) {
              const { number, match, text } = visible[index++]!;
              const mark = match ? ":" : "-";
              group.push(`${number - file.first + 1}${mark} ${text.slice(0, 512)}${text.length > 512 ? " [line truncated]" : ""}`);
            }
            const displayPath = directory ? relative(canonicalRoot, file.path) : file.path;
            const preamble = output.length || !directory ? [] : [`Root ${JSON.stringify(canonicalRoot)} (file paths below are relative)`];
            const first = [...preamble, `File ${JSON.stringify(displayPath)}`, group[0]!];
            const firstSize = first.reduce((size, line, item) =>
              size + Buffer.byteLength(line) + (output.length || item ? 1 : 0), 0);
            // Admit a group header only together with its first result line.
            if (outputBytes + firstSize > RESULT_BYTES) {
              incomplete = true; resultLimitReached = true; break;
            }
            output.push(...first); outputBytes += firstSize;
            for (const line of group.slice(1)) {
              const size = Buffer.byteLength(line) + 1;
              if (outputBytes + size > RESULT_BYTES) {
                incomplete = true; resultLimitReached = true; break;
              }
              output.push(line); outputBytes += size;
            }
            if (resultLimitReached) break;
          }
          batch = []; batchBytes = 0; nextLine = 1;
        };
        for (const path of names) {
          aborted(signal);
          if (matches > limit || resultLimitReached) { incomplete = true; break; }
          const lexical = directory ? resolve(root, relative(canonicalRoot, path)) : root;
          if (directory && !inside(path, canonicalRoot)) { skipped.unavailable += 1; continue; }
          // Deduplicate identical spellings for this file only. Do not cache
          // permission decisions across files, policy changes or tool calls.
          const checked = new Set<string>();
          const check = (name: string) => {
            if (checked.has(name)) return true;
            if (!permitted(name)) return false;
            checked.add(name); return true;
          };
          if (!check(lexical) || !check(path)) { skipped.permission += 1; continue; }
          let file;
          let data: Buffer | undefined;
          try {
            // No content reads before permissions; nonblocking open also avoids
            // a newly substituted FIFO. Explicit files use the same pinned read.
            file = await open(directory ? path : root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const actual = await readlink(`/proc/self/fd/${file.fd}`);
            const opened = await file.stat();
            if (!opened.isFile() || (directory && !inside(actual, canonicalRoot))) { skipped.unavailable += 1; continue; }
            if (!check(actual)) { skipped.permission += 1; continue; }
            const named = await stat(actual);
            if (named.dev !== opened.dev || named.ino !== opened.ino) { skipped.unavailable += 1; continue; }
            if (opened.size > FILE_BYTES) { skipped.tooLarge += 1; continue; }
            const buffer = readBuffer;
            let read = 0;
            while (read < buffer.length) {
              aborted(signal);
              const result = await file.read(buffer, read, buffer.length - read, read);
              if (!result.bytesRead) break;
              read += result.bytesRead;
            }
            if (read > FILE_BYTES) { skipped.tooLarge += 1; continue; }
            data = Buffer.from(buffer.subarray(0, read));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ELOOP") skipped.symlink += 1;
            else if (signal.aborted) throw error;
            else skipped.unavailable += 1;
          } finally { await file?.close(); }
          if (!data) continue;
          inputBytes += data.length;
          if (inputBytes > TOTAL_BYTES) { incomplete = true; break; }
          if (data.includes(0)) { skipped.binary += 1; continue; }
          if (!data.length) { searched += 1; continue; }
          if (data[data.length - 1] !== 10) data = Buffer.concat([data, Buffer.from("\n")]);
          let lines = 0;
          for (const byte of data) if (byte === 10) lines += 1;
          if (batchBytes + data.length > BATCH_BYTES) await flush();
          if (matches > limit || resultLimitReached) { incomplete = true; break; }
          batch.push({ path, first: nextLine, lines, bytes: data });
          nextLine += lines; batchBytes += data.length;
          if (batch.length >= 128) await flush();
        }
        if (matches <= limit && !resultLimitReached) await flush();
        const notes = [`Searched ${searched} permitted text files.`,
          `Skipped: permission=${skipped.permission}, size=${skipped.tooLarge}, binary=${skipped.binary}, unavailable=${skipped.unavailable}, explicit-symlink=${skipped.symlink}.`,
          directory ? "Directory scope excludes .git, node_modules and symlinks; ignore-files are not read. Use path/glob to narrow the scope." : "Explicit file scope; directory grants are not used for descendants.",
          ...(incomplete ? ["Search incomplete: a work/output limit was reached; narrow path/glob."] : []),
          ...(searched === 0 && skipped.permission ? ["No permitted files were searched. A one-time directory approval does not authorize descendants; use explicit file reads/searches or configure the exact directory's read scope."] : [])];
        return { content: [{ type: "text", text: [output.join("\n") || "No text matches in the searched files.", ...notes].join("\n\n") }],
          details: { policyFiltered: true, searchedFiles: searched, skippedFiles: Object.values(skipped).reduce((a, b) => a + b, 0), skipped, incomplete } };
      } finally { clearTimeout(timer); }
    },
  });
  return () => pi.getAllTools().find((tool) => tool.name === "grep")?.parameters === parameters;
}

export default function policyGrep(pi: ExtensionAPI): void {
  const registration = { isBound: registerPolicyGrep(pi) };
  if (process.env.PI_POLICY_GREP_SELFTEST === "1") console.log("policy-grep factory loaded");
  let sessionId: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (sessionId && policyGrepRegistry().get(sessionId) === registration) policyGrepRegistry().delete(sessionId);
    sessionId = ctx.sessionManager.getSessionId();
    policyGrepRegistry().set(sessionId, registration);
  });
  pi.on("session_shutdown", () => {
    if (sessionId && policyGrepRegistry().get(sessionId) === registration) policyGrepRegistry().delete(sessionId);
  });
}
