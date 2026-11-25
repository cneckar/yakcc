/* SPDX-License-Identifier: Apache-2.0
 * Node's HdrHistogram (vendor/node/deps/histogram), as Node's perf_hooks histogram runs it (#1367,
 * src/histogram-inl.h): values recorded (those outside its range counted as exceeding), then its
 * min, max, mean and standard deviation, the value at each percentile asked, and the percentiles
 * iteration (one tick per half distance). Doubles are written as their bits. */
#include <stdio.h>
#include <string.h>
#include "hdr/hdr_histogram.h"

static long yk_bits(char *o, long cap, long n, const char *tag, double v) {
  unsigned long long u;
  memcpy(&u, &v, 8);
  return n + snprintf(o + n, (size_t)(cap - n), "%s%016llx", tag, u);
}

long yk_histogram(const long long *vals, long n, long long lowest, long long highest, int figures,
                  const double *ps, long np, char *out, long cap) {
  struct hdr_histogram *h;
  if (hdr_init(lowest, highest, figures, &h) != 0) return -1;
  long count = 0, exceeds = 0, k = 0;
  for (long i = 0; i < n; i++) {
    if (hdr_record_value(h, vals[i])) count++;
    else exceeds++;
  }
  k += snprintf(out + k, (size_t)(cap - k), "count %ld exceeds %ld min %lld max %lld", count, exceeds,
                (long long)hdr_min(h), (long long)hdr_max(h));
  k = yk_bits(out, cap, k, " mean ", hdr_mean(h));
  k = yk_bits(out, cap, k, " stddev ", hdr_stddev(h));
  for (long i = 0; i < np; i++)
    k += snprintf(out + k, (size_t)(cap - k), " p%ld=%lld", i, (long long)hdr_value_at_percentile(h, ps[i]));
  struct hdr_iter it;
  hdr_iter_percentile_init(&it, h, 1);
  while (hdr_iter_next(&it) && k < cap - 64) {
    k = yk_bits(out, cap, k, " ", it.specifics.percentiles.percentile);
    k += snprintf(out + k, (size_t)(cap - k), "=%lld", (long long)it.value);
  }
  k += snprintf(out + k, (size_t)(cap - k), " size %zu", hdr_get_memory_size(h));
  hdr_close(h);
  return k;
}
