// SPDX-License-Identifier: Apache-2.0
// libstdc++'s explicit instantiations, as its own src/c++11/string-inst.cc makes them for
// libstdc++.so: its headers declare std::string's members `extern template`, so a unit that uses
// them calls the library's copies. Compiled here from the same headers, they are atoms.
#include <string>

template class std::__cxx11::basic_string<char>;
