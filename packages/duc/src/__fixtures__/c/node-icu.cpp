// SPDX-License-Identifier: Apache-2.0
// Node's ICU (vendor/node/deps/icu-small, 78.3) through its C API, as V8's String and Intl
// built-ins call it: case mapping (toLocaleUpperCase, toLocaleLowerCase), normalization
// (normalize), collation (Intl.Collator's compare) and decimal formatting (Intl.NumberFormat's
// format). The data is the bytes Node links in as icudt78_dat, given by udata_setCommonData.
#include <unicode/ucol.h>
#include <unicode/udata.h>
#include <unicode/unorm2.h>
#include <unicode/unum.h>
#include <unicode/ustring.h>

extern "C" {

/** The data, set once: ICU's error code (0 when it took it). */
int yk_icu_init(const void *data) {
  UErrorCode err = U_ZERO_ERROR;
  udata_setCommonData(data, &err);
  return static_cast<int>(err);
}

/** Case mapping of s (n UTF-16 units) in `locale`: 0 upper, 1 lower. The length, or -error. */
int yk_icu_case(int op, const char *locale, const UChar *s, int n, UChar *out, int cap) {
  UErrorCode err = U_ZERO_ERROR;
  const int r = op == 0 ? u_strToUpper(out, cap, s, n, locale, &err)
                        : u_strToLower(out, cap, s, n, locale, &err);
  return U_FAILURE(err) ? -static_cast<int>(err) : r;
}

/** s normalized: 0 NFC, 1 NFD, 2 NFKC, 3 NFKD. The length, or -error. */
int yk_icu_norm(int form, const UChar *s, int n, UChar *out, int cap) {
  UErrorCode err = U_ZERO_ERROR;
  const UNormalizer2 *norm = form == 0   ? unorm2_getNFCInstance(&err)
                             : form == 1 ? unorm2_getNFDInstance(&err)
                             : form == 2 ? unorm2_getNFKCInstance(&err)
                                         : unorm2_getNFKDInstance(&err);
  if (U_FAILURE(err)) return -static_cast<int>(err);
  const int r = unorm2_normalize(norm, s, n, out, cap, &err);
  return U_FAILURE(err) ? -static_cast<int>(err) : r;
}

/** a against b in `locale`'s collation: -1, 0 or 1; or -100 - error. */
int yk_icu_coll(const char *locale, const UChar *a, int na, const UChar *b, int nb) {
  UErrorCode err = U_ZERO_ERROR;
  UCollator *c = ucol_open(locale, &err);
  if (U_FAILURE(err)) return -100 - static_cast<int>(err);
  const UCollationResult r = ucol_strcoll(c, a, na, b, nb);
  ucol_close(c);
  return static_cast<int>(r);
}

/** v as `locale`'s decimal format writes it (UTF-16). The length, or -error. */
int yk_icu_num(const char *locale, double v, UChar *out, int cap) {
  UErrorCode err = U_ZERO_ERROR;
  UNumberFormat *f = unum_open(UNUM_DECIMAL, nullptr, 0, locale, nullptr, &err);
  if (U_FAILURE(err)) return -static_cast<int>(err);
  const int r = unum_formatDouble(f, v, out, cap, nullptr, &err);
  unum_close(f);
  return U_FAILURE(err) ? -static_cast<int>(err) : r;
}
}
