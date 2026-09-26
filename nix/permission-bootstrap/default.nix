{
  runCommand,
  pi-alehouse,
}:
# Persistent rollback bootstrap for ordinary Pi. It is a separate derivation, not
# a sibling of the generated authority: activation copies it out of the store so
# it survives rollback and GC. Both launch modes use the generated authority.
runCommand "pi-alehouse-permission-bootstrap" {} ''
  authority=${pi-alehouse}/lib/node_modules/pi-alehouse/runtime/permission-system
  # The bootstrap calls these by name; fail the build, not a later session.
  grep -q '^export function guardSingleAuthority(' "$authority/authority-guard.ts"
  grep -q '"version": "32.0.3"' "$authority/vendor/package.json"
  grep -q '!== "32.0.3"' ${./bootstrap.ts}

  mkdir -p "$out"
  printf '%s\n' '// pi-managed-permissions-bootstrap v1' > "$out/bootstrap.ts"
  cat "$authority/authority-guard.ts" ${./bootstrap.ts} >> "$out/bootstrap.ts"
  cat >> "$out/bootstrap.ts" <<'EOF'
  export default async function (pi: ExtensionAPI) {
    guardSingleAuthority(pi);
    await loadPermissionAuthority(pi);
  }
  EOF
  cp ${./migrate-settings.mjs} "$out/migrate-settings.mjs"
''
