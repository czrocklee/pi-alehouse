{
  lib,
  buildNpmPackage,
  makeWrapper,
  util-linux,
  # Only the credential file path, never the credential, enters the wrapper/store.
  jevApiKeyFile ? null,
  # Launcher defaults (`--set-default`); the caller's environment still wins.
  environment ? {},
}: let
  root = ../.;
  # Build inputs only: local dependencies/outputs and Nix packaging never enter
  # the npm source, so Nix-only edits do not rebuild the package.
  # Mirrors .gitignore; `runtime` is anchored because test/runtime is source.
  excludedNames = ["node_modules" "coverage" "artifacts" ".cache" ".git"];
  excludedPaths = ["runtime" "harness/dist" "nix" "flake.nix" "flake.lock" "result"];
  src = lib.cleanSourceWith {
    src = root;
    name = "pi-alehouse-source";
    filter = path: _type:
      !(lib.elem (baseNameOf path) excludedNames)
      && !(lib.elem (lib.removePrefix (toString root + "/") (toString path)) excludedPaths);
  };
in
  buildNpmPackage {
    pname = "pi-alehouse";
    version = (lib.importJSON ../package.json).version;
    inherit src;
    # Update with package-lock.json (nix build reports the expected hash).
    npmDepsHash = "sha256-bBZ2tEnZrD9EJUEcnewvhKrsIv+mr8IVq+Mv36cbQD4=";

    # Parser WASM is already shipped. Never run native tree-sitter install scripts.
    npmFlags = ["--ignore-scripts" "--legacy-peer-deps"];
    # npm refreshes cache metadata while unpacking Pi's bundled SDK dependencies.
    makeCacheWritable = true;
    npmBuildScript = "build";
    nativeBuildInputs = [makeWrapper];

    postInstall = ''
      root="$out/lib/node_modules/pi-alehouse"
      # Pi supplies these imports through its extension loader. Some dependencies
      # list TypeBox/Pi as production dependencies, so npm prune alone is not enough.
      find "$root/node_modules" -depth -type d \( \
        -path '*/node_modules/@earendil-works/pi-ai' -o \
        -path '*/node_modules/@earendil-works/pi-agent-core' -o \
        -path '*/node_modules/@earendil-works/pi-coding-agent' -o \
        -path '*/node_modules/@earendil-works/pi-tui' -o \
        -path '*/node_modules/typebox' \
      \) -exec rm -rf {} +
      if [ -d "$root/node_modules/.bin" ]; then
        find "$root/node_modules/.bin" -xtype l -delete
      fi

      # One installed root keeps Jiti-realpathed policy/lib/vendor imports siblings.
      test -f "$root/runtime/permission-system/index.ts"
      test -f "$root/runtime/permission-system/vendor/package.json"
      test -f "$root/runtime/policy/status-footer.ts"
      test -f "$root/runtime/worker-policy.json"
      node --input-type=module - "$root" <<'EOF'
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const root = process.argv[2];
      const manifest = JSON.parse(readFileSync(root + "/package.json", "utf8"));
      assert.equal(manifest.name, "pi-alehouse");
      assert.deepEqual(manifest.pi.extensions, [], "Alehouse must not autoload into ordinary Pi");
      const { verifyRuntime, webEntry } = await import(pathToFileURL(root + "/bin/runtime-support.mjs"));
      verifyRuntime(root);
      webEntry(root);
      EOF

      wrapProgram "$out/bin/pi-alehouse" \
        --set PI_HARNESS_PERMISSION_ROOT "$root/runtime/permission-system" \
        --set PI_HARNESS_POLICY_ROOT "$root/runtime/policy" \
        --set PI_HARNESS_FLOCK ${util-linux}/bin/flock \
        --set PI_AUTO_APPROVAL_MODE shadow \
        --set-default PI_JEV_APPROVAL_MODE enforce-subagents \
        ${lib.concatStringsSep " " (lib.mapAttrsToList (name: value: "--set-default ${lib.escapeShellArg name} ${lib.escapeShellArg value}") environment)} \
        ${
        if jevApiKeyFile == null
        then "--unset PI_JEV_API_KEY_FILE"
        else "--set PI_JEV_API_KEY_FILE ${lib.escapeShellArg jevApiKeyFile}"
      }
      # Transitional command alias; both names enter the exact same composition.
      ln -s pi-alehouse "$out/bin/pi-harness"
    '';

    meta = {
      description = "Opt-in Pi Alehouse multi-agent composition (host Pi runtime)";
      homepage = "https://github.com/czrocklee/pi-alehouse";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
      mainProgram = "pi-alehouse";
    };
  }
