# ada 2.9.2 (vendored)

The single-header release (`ada.h`, `ada.cpp`), from
https://github.com/ada-url/ada/releases/tag/v2.9.2, unmodified, under ada's licenses
(`LICENSE-MIT`, `LICENSE-APACHE`; either): Node's WHATWG URL parser (`deps/ada`), for the C++
front end to shave (#1367).

Built as Node builds it on x86-64 (its SSE2 paths included), with libstdc++'s assertions on so that
`std::string`'s members are instantiated in the unit rather than taken from the library:
`-std=c++17 -DNDEBUG -D_GLIBCXX_ASSERTIONS`. The fixture `src/__fixtures__/c/ada-run.cpp` includes
`ada.cpp` and names a parse as a C function.
