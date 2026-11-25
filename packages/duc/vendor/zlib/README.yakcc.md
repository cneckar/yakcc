# zlib 1.3.1 (vendored)

From https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz
(sha256 `9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23`): the library's own
sources (no gz* file functions but the header zutil.c includes, no contrib), unmodified, under zlib's license (`LICENSE`), for
the C front end to shave (#1367: Node's `zlib` binding is zlib's deflate and inflate).

The fixture `src/__fixtures__/c/zlib-run.c` includes them as one unit and names a compression and
a decompression as C functions.
