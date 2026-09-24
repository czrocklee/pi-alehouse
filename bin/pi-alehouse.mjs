#!/usr/bin/env node
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { executable, packageRoot, preflight, runtimeEnvironment } from "./runtime-support.mjs";

const args = process.argv.slice(2);
try {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: pi-alehouse init | [Pi options] [--] [prompt]\n\nInit creates absent worker profiles, an Off preset catalogue, and a conservative\npermission policy in PI_CODING_AGENT_DIR (default ~/.pi/agent). It never overwrites\nexisting resources, settings or credentials. Launch uses one guarded composition\nwith discovered extensions disabled. Additional -e/--extension paths and live\nreload are unsupported. Use plain pi --help for host options.\n\nRequires an installed host pi and Linux util-linux flock. Optional overrides:\nPI_ALEHOUSE_PI (absolute executable), PI_HARNESS_FLOCK (absolute util-linux flock).\nNo automatic installs, network setup, or credential copying.");
  } else if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    console.log(`pi-alehouse ${JSON.parse(readFileSync(join(packageRoot, "package.json"))).version}`);
  } else if (args[0] === "init") {
    if (args.length !== 1) throw new Error("Usage: pi-alehouse init (directory: PI_CODING_AGENT_DIR)");
    const { initialize } = await import("../scripts/init.mjs");
    const result = initialize();
    console.log(`Initialized ${result.created.length} absent resources; preserved ${result.preserved.length}. Settings and credentials were not changed.`);
  } else {
    const boundary = args.indexOf("--");
    const options = boundary < 0 ? args : args.slice(0, boundary);
    if (options.includes("-e") || options.includes("--extension") || options.some((arg) => arg.startsWith("--extension=") || /^-e.+/.test(arg))) {
      throw new Error("Additional extensions are not supported: Alehouse owns one composition. Use plain pi for other extensions.");
    }
    if (["install", "remove", "uninstall", "update", "config"].includes(args[0])) throw new Error("Package/settings mutations belong to plain pi, not the Alehouse launcher.");
    const paths = preflight();
    const pi = executable("pi", process.env.PI_ALEHOUSE_PI);
    // Replace this process exactly as the original shell exec launcher did.
    // A supervising child would receive terminal signals twice (foreground
    // process group plus forwarding), weakening cooperative cancellation.
    if (typeof process.execve !== "function") throw new Error("This Node runtime lacks process.execve; use supported Linux Node >=22.19 (no spawn fallback)");
    process.execve(pi, [pi, "--no-extensions", "-e", join(packageRoot, "composition.ts"), ...args], runtimeEnvironment(paths));
  }
} catch (error) {
  console.error(`pi-alehouse: ${error.message}\nRun pi-alehouse init for absent resources; reconcile conflicts manually. Nothing was overwritten.`);
  process.exitCode = 1;
}
