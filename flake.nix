{
  description = "Pi Alehouse: opt-in multi-agent composition for a host Pi installation";

  # Nix packaging only; the npm source package itself does not depend on Nix.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAllSystems (pkgs: rec {
      alehouse = pkgs.callPackage ./nix/package.nix {};
      permission-bootstrap = pkgs.callPackage ./nix/permission-bootstrap {inherit alehouse;};
      default = alehouse;
    });

    # Builds with the consumer's pkgs; host Pi stays separately installed.
    homeManagerModules.default = ./nix/hm-module.nix;
    homeManagerModules.alehouse = self.homeManagerModules.default;

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
