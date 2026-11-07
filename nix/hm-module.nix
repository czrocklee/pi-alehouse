{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.alehouse;
  agentDir = ".pi/agent";

  environment =
    lib.optionalAttrs (cfg.dashboardUrl != null) {AGENT_DASHBOARD_URL = cfg.dashboardUrl;}
    // lib.optionalAttrs cfg.grokBilling {PI_ALEHOUSE_GROK_BILLING = "1";};
  package = cfg.package.override {
    inherit (cfg) jevApiKeyFile;
    inherit environment;
  };
  generated = "${package}/lib/node_modules/pi-alehouse/generated";
  bootstrap = pkgs.callPackage ./permission-bootstrap {alehouse = package;};

  # Generated worker profiles; the launcher preflight requires exact copies.
  agents = ["editor" "researcher" "Explore" "Plan" "general-purpose"];
  # Policy/UI extensions that ordinary Pi autoloads from its extensions dir.
  autoloadExtensions = [
    "status-footer"
    "approval-mode"
    "stats"
    "terminal-title-status"
    "ui-prompt-queue"
    "static-safety-guard"
    "policy-grep"
  ];
in {
  options.programs.alehouse = {
    enable = lib.mkEnableOption "Pi Alehouse for a host Pi installation";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix {};
      defaultText = lib.literalExpression "pkgs.callPackage ./nix/package.nix {}";
      description = ''
        Alehouse package built by `nix/package.nix`. It must accept `override`
        for `jevApiKeyFile` and `environment`.
      '';
    };

    permissions = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Permission policy installed as `extensions/pi-permission-system/config.json`.
        Activation restores it if the settings UI rewrote the file. When null,
        the file stays user-owned (see `alehouse init`).
      '';
    };

    presets = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Worker preset catalogue installed as `alehouse-presets.json`. When null,
        the file stays user-owned (see `alehouse init`).
      '';
    };

    jevApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = lib.literalExpression ''config.sops.secrets."ai/jev/api-key".path'';
      description = ''
        Runtime path of the Jev API key. Only the path enters the store. When
        null, Jev defers every ask without making a request.
      '';
    };

    dashboardUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://127.0.0.1:3030";
      description = "Agent dashboard base URL for the status footer. Disabled when null.";
    };

    grokBilling = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether the status footer queries xAI billing for Grok spend.";
    };

    ordinaryPi.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether ordinary `pi` also loads the Alehouse policy/UI extensions and
        the managed permission authority. Activation installs a persistent
        bootstrap and pins the public permission package in `settings.json`;
        disabling this option later does not remove them.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.packages = [package];
      home.sessionVariables = environment;

      home.file = lib.mkMerge [
        (lib.listToAttrs (map (name:
          lib.nameValuePair "${agentDir}/agents/${name}.md" {source = "${generated}/agents/${name}.md";})
        agents))
        (lib.mkIf (cfg.presets != null) {
          "${agentDir}/alehouse-presets.json".source = cfg.presets;
        })
        # The permission settings UI rewrites this path atomically; force
        # restores the declarative policy on activation.
        (lib.mkIf (cfg.permissions != null) {
          "${agentDir}/extensions/pi-permission-system/config.json" = {
            source = cfg.permissions;
            force = true;
          };
        })
      ];
    }

    (lib.mkIf cfg.ordinaryPi.enable {
      home.file = lib.mkMerge [
        # Pi resolves an entry's relative imports from its ~/.pi path, not the
        # store target, so a symlinked entry cannot reach generated/shared. A shim
        # makes the store file the entry and keeps every import inside it.
        (lib.listToAttrs (map (name:
          lib.nameValuePair "${agentDir}/extensions/${name}.ts" {
            text = ''
              export { default } from "${generated}/extensions/${name}.ts";
            '';
          })
        autoloadExtensions))
        {
          # HM owns the selector, NOT the persistent bootstrap. An older
          # generation removes this selector; the bootstrap then loads the
          # public authority instead of leaving tools without permission checks.
          "${agentDir}/managed-permissions.json".text = builtins.toJSON {
            version = 1;
            entryPoint = "${generated}/authority/index.ts";
          };
        }
      ];

      # Link the selector first; copy the self-contained bootstrap before
      # disabling npm's automatic authority. The copy survives rollback and GC.
      home.activation.piAlehousePermissions = lib.hm.dag.entryAfter ["linkGeneration"] ''
        settings="$HOME/${agentDir}/settings.json"
        if [ ! -e "$settings" ]; then
          run mkdir -p -m 700 "$(dirname "$settings")"
          run install -m 600 /dev/null "$settings"
          [ -n "''${DRY_RUN:-}" ] || printf '{}\n' > "$settings"
        fi
        run ${lib.getExe pkgs.nodejs} ${bootstrap}/migrate-settings.mjs "$settings" ${bootstrap}/bootstrap.ts
      '';
    })
  ]);
}
