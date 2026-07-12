{
  # Reproducible toolchain for the DUC Coq proof harness (S6,
  # DEC-DUC-MECHANIZATION-001), mirroring the paper artifact's nix-pinned setup.
  #
  # `nix develop`  -> a shell with coq + make on PATH (for local proving).
  # `nix build`    -> runs `make verify` hermetically; fails on any proof hole.
  #
  # NOTE: flake.lock is generated with `nix flake lock` in a Nix environment.
  # This flake was authored against Coq 8.18 (Ubuntu universe) but has NOT been
  # evaluated with Nix in the dev container that produced it (no nix available);
  # the apt path in .github/workflows/duc-coq.yml is the CI-verified route.
  description = "DUC Coq proof harness — reproducible Rocq/Coq toolchain (S6).";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.coq pkgs.gnumake ];
        };
      });

      # `nix build` / `nix flake check` machine-checks the development.
      packages = forAll (pkgs: {
        default = pkgs.stdenv.mkDerivation {
          pname = "duc-coq-verify";
          version = "0.6.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.coq pkgs.gnumake ];
          buildPhase = "make verify";
          installPhase = "mkdir -p $out && cp -f *.vo $out/ 2>/dev/null || true; touch $out/verified";
        };
      });
    };
}
