{
  description = "pi-infinite-context — development toolchain for the pi extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      # Toolchain only. The type-declaration libraries the type-checker needs
      # come from `npm ci` (they are versioned pi npm packages), so the dev loop
      # is `nix develop` then `npm ci && npm run ci`.
      devShells.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24 # node --test runner (strips TS types natively)
          pkgs.typescript-go # `tsgo` type-checker
          pkgs.oxlint # linter
        ];
      };
    });
}
