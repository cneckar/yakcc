/* SPDX-License-Identifier: Apache-2.0
 * Node's OpenSSL (vendor/node/deps/openssl, 3.5.9, no-asm) through the EVP calls behind Node's
 * crypto module (#1367): digests (createHash, XOFs with their length), HMAC (createHmac), ciphers
 * (createCipheriv: CBC, CTR, GCM and ChaCha20-Poly1305 with their tags), pbkdf2Sync, hkdfSync
 * and scryptSync. Each returns the bytes written (or a negative failure). */
#include <string.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/kdf.h>
#include <openssl/core_names.h>

long yk_digest(const char *name, const unsigned char *data, long n, long xof, unsigned char *out) {
  EVP_MD *md = EVP_MD_fetch(NULL, name, NULL);
  if (md == NULL) return -1;
  EVP_MD_CTX *c = EVP_MD_CTX_new();
  unsigned int len = 0;
  long r = -2;
  if (EVP_DigestInit_ex(c, md, NULL) && EVP_DigestUpdate(c, data, (size_t)n)) {
    if (xof > 0) r = EVP_DigestFinalXOF(c, out, (size_t)xof) ? xof : -3;
    else r = EVP_DigestFinal_ex(c, out, &len) ? (long)len : -4;
  }
  EVP_MD_CTX_free(c);
  EVP_MD_free(md);
  return r;
}

long yk_hmac(const char *md, const unsigned char *key, long kn, const unsigned char *data, long n,
             unsigned char *out) {
  unsigned int len = 0;
  const EVP_MD *m = EVP_get_digestbyname(md);
  if (m == NULL) return -1;
  return HMAC(m, key, (int)kn, data, (size_t)n, out, &len) ? (long)len : -2;
}

/* Encrypt (enc 1) or decrypt (0); an AEAD's tag (taglen bytes) written after the output when
   encrypting, checked when decrypting (from tag). */
long yk_cipher(const char *name, const unsigned char *key, const unsigned char *iv, long ivn,
               const unsigned char *aad, long aadn, const unsigned char *in, long n, int enc,
               long taglen, const unsigned char *tag, unsigned char *out) {
  EVP_CIPHER *ci = EVP_CIPHER_fetch(NULL, name, NULL);
  if (ci == NULL) return -1;
  EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
  int aead = (EVP_CIPHER_get_flags(ci) & EVP_CIPH_FLAG_AEAD_CIPHER) != 0;
  long r = -2;
  int len = 0, fin = 0;
  if (!EVP_CipherInit_ex(c, ci, NULL, NULL, NULL, enc)) goto done;
  if (aead && !EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_IVLEN, (int)ivn, NULL)) goto done;
  if (!EVP_CipherInit_ex(c, NULL, NULL, key, iv, enc)) goto done;
  if (aead && !enc && !EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_TAG, (int)taglen, (void *)tag)) goto done;
  if (aead && aadn > 0 && !EVP_CipherUpdate(c, NULL, &len, aad, (int)aadn)) goto done;
  if (!EVP_CipherUpdate(c, out, &len, in, (int)n)) goto done;
  if (!EVP_CipherFinal_ex(c, out + len, &fin)) {
    r = -3;
    goto done;
  }
  r = len + fin;
  if (aead && enc) {
    if (!EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_GET_TAG, (int)taglen, out + r)) r = -4;
    else r += taglen;
  }
done:
  EVP_CIPHER_CTX_free(c);
  EVP_CIPHER_free(ci);
  return r;
}

long yk_pbkdf2(const char *pass, long pn, const unsigned char *salt, long sn, long iter,
               const char *md, long keylen, unsigned char *out) {
  const EVP_MD *m = EVP_get_digestbyname(md);
  if (m == NULL) return -1;
  return PKCS5_PBKDF2_HMAC(pass, (int)pn, salt, (int)sn, (int)iter, m, (int)keylen, out) ? keylen : -2;
}

long yk_hkdf(const char *md, const unsigned char *key, long kn, const unsigned char *salt, long sn,
             const unsigned char *info, long in, long keylen, unsigned char *out) {
  EVP_KDF *k = EVP_KDF_fetch(NULL, "HKDF", NULL);
  if (k == NULL) return -1;
  EVP_KDF_CTX *c = EVP_KDF_CTX_new(k);
  OSSL_PARAM ps[5], *p = ps;
  *p++ = OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, (char *)md, 0);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, (void *)key, (size_t)kn);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)salt, (size_t)sn);
  *p++ = OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, (void *)info, (size_t)in);
  *p = OSSL_PARAM_construct_end();
  long r = EVP_KDF_derive(c, out, (size_t)keylen, ps) > 0 ? keylen : -2;
  EVP_KDF_CTX_free(c);
  EVP_KDF_free(k);
  return r;
}

long yk_scrypt(const char *pass, long pn, const unsigned char *salt, long sn, long N, long r,
               long p, long keylen, unsigned char *out) {
  return EVP_PBE_scrypt(pass, (size_t)pn, salt, (size_t)sn, (uint64_t)N, (uint64_t)r, (uint64_t)p,
                        64 * 1024 * 1024, out, (size_t)keylen)
             ? keylen
             : -2;
}
