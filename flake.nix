{
  description = "Ever17 preservation toolkit: SC3 scenario parser, asset decoders, VN runtime";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            # exploratory binary analysis only; final parser is TypeScript
            (python3.withPackages (ps: [ ]))
            xxd
          ];
        };
      });
}
