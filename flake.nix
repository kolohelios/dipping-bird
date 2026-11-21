{
  description = "Dipping Bird development and CI tools";

  inputs = {
    shaka.url = "https://flakehub.com/f/kolohelios/shaka/*.tar.gz";
    nixpkgs.follows = "shaka/nixpkgs";
  };

  outputs =
    { nixpkgs, shaka, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAll = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAll (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          shell =
            node:
            pkgs.mkShell {
              packages = [
                node
                shaka.packages.${system}.default
                pkgs.just
                pkgs.jujutsu
                pkgs.cue
                pkgs.actionlint
                pkgs.shellcheck
                pkgs.typos
                pkgs.taplo
                pkgs.nixfmt
              ];
            };
        in
        {
          default = shell pkgs.nodejs_24;
          node22 = shell pkgs.nodejs_22;
        }
      );
      formatter = forAll (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
