// SPDX-License-Identifier: Apache-2.0
// The C++ runtime's functions a shaved C++ library calls that libstdc++ compiles (not its
// headers): for one thread, as the shaved code runs. ICU's umutex waits on a condition variable
// only while another thread initializes what it needs; with one thread none does, so a wait would
// never end: the program ends, as a deadlock's would not. The headers are glibc's and the C
// library musl, which has no `__libc_single_threaded` (glibc's flag that libstdc++'s shared_ptr
// reads to skip its atomics): one thread, so 1.
#include <sys/single_threaded.h>

#include <condition_variable>
#include <cstdlib>

char __libc_single_threaded = 1;

namespace std {
condition_variable::condition_variable() noexcept {}
condition_variable::~condition_variable() noexcept {}
void condition_variable::notify_all() noexcept {}
void condition_variable::wait(unique_lock<mutex> &) { abort(); }
}  // namespace std
