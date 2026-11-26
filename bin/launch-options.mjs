// Pi 1.6.1 dist/cli/args.js: these built-in options consume the next argv
// token even when it looks like a flag or the -- separator. Keep this bounded
// inventory in parity with the development SDK (test/packaging/launch-options.test.mjs).
const valueOptions = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

// A bounded scan, not an argv rewrite or validator. Pi's conditional/optional
// consumers (--mode, --use-theme, --tui-mode, --print/-p, --list-models and unknown
// long flags) cannot consume --no-skills, -ns, --, extension rejection spellings
// or any valueOptions spelling. Their values need no separate parsing here.
// Do not import Pi's private parser here: production uses a separately supplied host.
export function scanLaunchOptions(args) {
  const result = { noSkills: false, additionalExtensions: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "--no-skills" || arg === "-ns") result.noSkills = true;
    // Preserve all launcher rejection spellings, but only in option roles.
    if (
      arg === "-e" ||
      arg === "--extension" ||
      arg.startsWith("--extension=") ||
      /^-e.+/.test(arg)
    )
      result.additionalExtensions = true;
    if (valueOptions.has(arg) && i + 1 < args.length) i++;
  }
  return result;
}
