// SPDX-License-Identifier: Apache-2.0
// The C++ runtime's functions a shaved C++ library calls that libstdc++ compiles (not its
// headers): for one thread, as the shaved code runs. ICU's umutex waits on a condition variable
// only while another thread initializes what it needs; with one thread none does, so a wait would
// never end: the program ends, as a deadlock's would not.
#include <condition_variable>
#include <cstdlib>

namespace std {
condition_variable::condition_variable() noexcept {}
condition_variable::~condition_variable() noexcept {}
void condition_variable::notify_all() noexcept {}
void condition_variable::wait(unique_lock<mutex> &) { abort(); }
}  // namespace std
