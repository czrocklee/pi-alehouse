# Run with: nix-instantiate --eval --strict --expr 'import ./test/nix/hm-module.nix {}'
{pkgs ? import <nixpkgs> {}}: let
  inherit (pkgs) lib;
  target = ".pi/agent/alehouse-codex-speeds.json";
  source = ../../resources/alehouse-presets.json;
  evaluate = settings:
    (lib.evalModules {
      specialArgs = {
        inherit pkgs;
        lib = lib // {hm.dag.entryAfter = _: text: text;};
      };
      modules = [
        ../../nix/hm-module.nix
        {
          options.home = {
            packages = lib.mkOption {type = lib.types.listOf lib.types.package;};
            sessionVariables = lib.mkOption {type = lib.types.attrs;};
            activation = lib.mkOption {type = lib.types.attrs;};
            file = lib.mkOption {
              type = lib.types.lazyAttrsOf lib.types.anything;
              default = {};
            };
          };
          config.programs.alehouse = settings;
        }
      ];
    }).config;
  disabled = evaluate {codexSpeedLimits = source;};
  defaults = evaluate {
    enable = true;
    ordinaryPi.enable = false;
  };
  enabled = evaluate {
    enable = true;
    ordinaryPi.enable = false;
    codexSpeedLimits = source;
  };
in
  assert disabled.programs.alehouse.codexSpeedLimits == source;
  assert !(disabled.home.file ? ${target});
  assert defaults.programs.alehouse.codexSpeedLimits == null;
  assert !(defaults.home.file ? ${target});
  assert enabled.home.file.${target}.source == source; true
