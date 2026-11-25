/* SPDX-License-Identifier: Apache-2.0
 * Node's DNS library, c-ares (vendor/node/deps/cares), for the C front end's test (#1367): a DNS
 * response through each reply parser Node's dns.resolve* uses (A, AAAA, MX, NS, TXT, SRV, PTR,
 * NAPTR, SOA, CAA) and through the record layer (parsed, written back, parsed again), every
 * result logged. */
#include <stdio.h>
#include <string.h>
#include <arpa/inet.h>
#include <netdb.h>
#include "ares.h"
#include "ares_dns_record.h"

typedef struct {
  char *out;
  long cap, n;
} yk_log;

static void yk_put(yk_log *l, const char *s) {
  for (; *s && l->n < l->cap - 1; s++) l->out[l->n++] = *s;
}
static void yk_fmt(yk_log *l, const char *fmt, long a, long b) {
  char t[96];
  snprintf(t, sizeof t, fmt, a, b);
  yk_put(l, t);
}
static void yk_hex(yk_log *l, const unsigned char *p, size_t n) {
  static const char d[] = "0123456789abcdef";
  for (size_t i = 0; i < n && l->n < l->cap - 2; i++) {
    l->out[l->n++] = d[p[i] >> 4];
    l->out[l->n++] = d[p[i] & 15];
  }
}
static void yk_host(yk_log *l, struct hostent *h) {
  yk_put(l, " name=");
  yk_put(l, h->h_name ? h->h_name : "-");
  for (char **a = h->h_aliases; a && *a; a++) {
    yk_put(l, " alias=");
    yk_put(l, *a);
  }
  for (char **a = h->h_addr_list; a && *a; a++) {
    yk_put(l, " addr=");
    yk_hex(l, (unsigned char *)*a, (size_t)h->h_length);
  }
}

long yk_dns(const unsigned char *m, long n, char *out, long cap) {
  yk_log l = {out, cap, 0};
  int alen = (int)n;
  struct hostent *h = 0;
  struct ares_addrttl at[8];
  struct ares_addr6ttl at6[8];
  int na = 8, r;

  r = ares_parse_a_reply(m, alen, &h, at, &na);
  yk_fmt(&l, "A %ld", r, 0);
  if (r == ARES_SUCCESS) {
    yk_host(&l, h);
    for (int i = 0; i < na; i++) {
      yk_fmt(&l, " ttl=%ld ", at[i].ttl, 0);
      yk_hex(&l, (unsigned char *)&at[i].ipaddr, 4);
    }
    ares_free_hostent(h);
  }
  na = 8;
  r = ares_parse_aaaa_reply(m, alen, &h, at6, &na);
  yk_fmt(&l, "\nAAAA %ld", r, 0);
  if (r == ARES_SUCCESS) {
    yk_host(&l, h);
    for (int i = 0; i < na; i++) yk_fmt(&l, " ttl=%ld", at6[i].ttl, 0);
    ares_free_hostent(h);
  }
  struct ares_mx_reply *mx = 0;
  r = ares_parse_mx_reply(m, alen, &mx);
  yk_fmt(&l, "\nMX %ld", r, 0);
  for (struct ares_mx_reply *p = mx; r == ARES_SUCCESS && p; p = p->next) {
    yk_fmt(&l, " %ld:", p->priority, 0);
    yk_put(&l, p->host);
  }
  if (mx) ares_free_data(mx);
  r = ares_parse_ns_reply(m, alen, &h);
  yk_fmt(&l, "\nNS %ld", r, 0);
  if (r == ARES_SUCCESS) {
    yk_host(&l, h);
    ares_free_hostent(h);
  }
  struct ares_txt_ext *tx = 0;
  r = ares_parse_txt_reply_ext(m, alen, &tx);
  yk_fmt(&l, "\nTXT %ld", r, 0);
  for (struct ares_txt_ext *p = tx; r == ARES_SUCCESS && p; p = p->next) {
    yk_fmt(&l, " %ld:", p->record_start, 0);
    yk_hex(&l, p->txt, p->length);
  }
  if (tx) ares_free_data(tx);
  struct ares_srv_reply *sv = 0;
  r = ares_parse_srv_reply(m, alen, &sv);
  yk_fmt(&l, "\nSRV %ld", r, 0);
  for (struct ares_srv_reply *p = sv; r == ARES_SUCCESS && p; p = p->next) {
    yk_fmt(&l, " %ld/%ld/", p->priority, p->weight);
    yk_fmt(&l, "%ld:", p->port, 0);
    yk_put(&l, p->host);
  }
  if (sv) ares_free_data(sv);
  unsigned char addr[4] = {192, 0, 2, 1};
  r = ares_parse_ptr_reply(m, alen, addr, 4, AF_INET, &h);
  yk_fmt(&l, "\nPTR %ld", r, 0);
  if (r == ARES_SUCCESS) {
    yk_host(&l, h);
    ares_free_hostent(h);
  }
  struct ares_naptr_reply *np = 0;
  r = ares_parse_naptr_reply(m, alen, &np);
  yk_fmt(&l, "\nNAPTR %ld", r, 0);
  for (struct ares_naptr_reply *p = np; r == ARES_SUCCESS && p; p = p->next) {
    yk_fmt(&l, " %ld/%ld:", p->order, p->preference);
    yk_put(&l, (const char *)p->flags);
    yk_put(&l, "|");
    yk_put(&l, (const char *)p->service);
    yk_put(&l, "|");
    yk_put(&l, (const char *)p->regexp);
    yk_put(&l, "|");
    yk_put(&l, p->replacement);
  }
  if (np) ares_free_data(np);
  struct ares_soa_reply *so = 0;
  r = ares_parse_soa_reply(m, alen, &so);
  yk_fmt(&l, "\nSOA %ld", r, 0);
  if (r == ARES_SUCCESS) {
    yk_put(&l, " ");
    yk_put(&l, so->nsname);
    yk_put(&l, " ");
    yk_put(&l, so->hostmaster);
    yk_fmt(&l, " %ld %ld", so->serial, so->refresh);
    yk_fmt(&l, " %ld %ld", so->retry, so->expire);
    yk_fmt(&l, " %ld", so->minttl, 0);
    ares_free_data(so);
  }
  struct ares_caa_reply *ca = 0;
  r = ares_parse_caa_reply(m, alen, &ca);
  yk_fmt(&l, "\nCAA %ld", r, 0);
  for (struct ares_caa_reply *p = ca; r == ARES_SUCCESS && p; p = p->next) {
    yk_fmt(&l, " %ld:", p->critical, 0);
    yk_hex(&l, p->property, p->plength);
    yk_put(&l, "=");
    yk_hex(&l, p->value, p->length);
  }
  if (ca) ares_free_data(ca);
  /* The record layer: parsed, written back, parsed and written again. */
  ares_dns_record_t *rec = 0;
  r = (int)ares_dns_parse(m, (size_t)n, 0, &rec);
  yk_fmt(&l, "\nRECORD %ld", r, 0);
  if (r == ARES_SUCCESS) {
    yk_fmt(&l, " id=%ld flags=%ld", ares_dns_record_get_id(rec), ares_dns_record_get_flags(rec));
    yk_fmt(&l, " rcode=%ld qd=%ld", ares_dns_record_get_rcode(rec), (long)ares_dns_record_query_cnt(rec));
    for (int s = 1; s <= 3; s++)
      yk_fmt(&l, " s%ld=%ld", s, (long)ares_dns_record_rr_cnt(rec, (ares_dns_section_t)s));
    unsigned char *w = 0;
    size_t wn = 0;
    r = (int)ares_dns_write(rec, &w, &wn);
    yk_fmt(&l, " write %ld ", r, 0);
    if (r == ARES_SUCCESS) {
      yk_hex(&l, w, wn);
      ares_dns_record_t *again = 0;
      r = (int)ares_dns_parse(w, wn, 0, &again);
      yk_fmt(&l, " again %ld", r, 0);
      if (again) ares_dns_record_destroy(again);
      ares_free_string(w);
    }
    ares_dns_record_destroy(rec);
  }
  yk_put(&l, "\n");
  return l.n;
}
