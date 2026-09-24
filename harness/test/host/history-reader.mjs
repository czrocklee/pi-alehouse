// Cold-process fixture. Only the trusted parent path + Run ID are handed over;
// child coordinates are discovered from the parent SDK log, never from IPC/map.
import { loadHost } from "../support/host.mjs";
import { readSdkRun } from "../../dist/history/history-reader.js";

const [piExecutable, parentFile, sessionDirectory, run_id] = process.argv.slice(2);
const { sdk } = await loadHost(piExecutable);
const result = await readSdkRun({ sessionManager: sdk.SessionManager, parentFile, sessionDirectory, run_id });
console.log(JSON.stringify(result));
