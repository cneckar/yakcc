{
  # Reproducible toolchain for the DUC Coq proof harness (S6,
  # DEC-DUC-MECHANIZATION-001), mirroring the paper artifact's nix-pinned setup.
  #
  # `nix develop`  -> a shell with coq + make on PATH (for local proving).
  # `nix build`    -> runs `make verify` hermetically; fails on any proof hole.
  #
  # The pin: nixpkgs is the NixOS 25.05 release tarball below (an immutable URL), and
  # flake.lock records its content hash. Its `coq` is Rocq 9.0.0 with its standard library.
  # The release server is used rather than `github:` so the pin resolves without GitHub's API.
  description = "DUC Coq proof harness — reproducible Rocq/Coq toolchain (S6).";

  inputs.nixpkgs.url = "https://releases.nixos.org/nixos/25.05/nixos-25.05.813814.ac62194c3917/nixexprs.tar.xz";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.coq pkgs.rocqPackages.stdlib pkgs.gnumake ];
        };
      });

      # `nix build` / `nix flake check` machine-checks the development.
      packages = forAll (pkgs: {
        default = pkgs.stdenv.mkDerivation {
          pname = "duc-coq-verify";
          version = "0.6.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.coq pkgs.rocqPackages.stdlib pkgs.gnumake ];
          buildPhase = "make verify";
          installPhase = "mkdir -p $out && cp -f *.vo $out/ 2>/dev/null || true; touch $out/verified";
        };
      });
    };
}
