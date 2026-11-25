# simdutf 7.3.0 (vendored)

The single-header release, from
https://github.com/simdutf/simdutf/releases/download/v7.3.0/singleheader.zip
(sha256 `512374f8291d3daf102ccd0ad223b1a8318358f7c1295efd4d9a3abbb8e4b6ff`): `simdutf.h` and
`simdutf.cpp`, unmodified, under simdutf's licenses (`LICENSE-MIT`, `LICENSE-APACHE`; either), for
the C++ front end to shave (#1364).

Built for its portable kernel only (no SIMD):
`-std=c++17 -DSIMDUTF_IMPLEMENTATION_HASWELL=0 -DSIMDUTF_IMPLEMENTATION_ICELAKE=0 -DSIMDUTF_IMPLEMENTATION_WESTMERE=0 -DSIMDUTF_IMPLEMENTATION_FALLBACK=1`.
Its scalar paths are in an anonymous namespace of `simdutf.cpp`; the fixture
`src/__fixtures__/c/simdutf-scalar.cpp` includes it and names them as C functions.
