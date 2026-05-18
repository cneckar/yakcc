// fastest-levenshtein@1.0.16 ESM entry (esm/mod.js) — vendored verbatim from npm tarball.
// WI-510 Slice 12 / #642 S12 — Levenshtein distance headline binding.
// Tarball sha256: 650310ac51ee96ae0f900751d47b2846f038b80fd3380f35533605f3704c5b5f
//
// @decision DEC-WI510-S12-ENTRY-PATH-ESM-MOD-001
// title: Slice 12 entry is esm/mod.js (NOT mod.js / CJS)
// status: accepted
// rationale: esm/mod.js is clean hand-authored ESM with arrow-function const bindings and
// named exports; no class, no IIFE, no __esModule prelude. mod.js (CJS) would re-engage
// #619 TSC-CJS-prelude territory unnecessarily. Single-file entry; zero imports; zero classes.
//
// @decision DEC-WI510-S12-NO-CLASSES-001
// title: esm/mod.js has zero classes; #666 engine-gap CANNOT apply
// status: accepted
// rationale: All bindings are arrow-function expressions assigned to const. No class, extends,
// or #foo private-field syntax. #666 (private class fields stub the whole file) cannot trigger.
//
// @decision DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001
// title: esm/mod.js has zero import declarations; externalSpecifiers === [] is the contract
// status: accepted
// rationale: First WI-510 fixture with zero imports of any kind. JavaScript globals
// (Uint32Array, Math, String, Infinity) are NOT imports; they are free identifier references.
//
// @decision DEC-WI510-S12-MODULE-SCOPE-TYPED-ARRAY-001
// title: const peq = new Uint32Array(0x10000) at module scope is opaque construction
// status: accepted
// rationale: Engine treats NewExpression as opaque (same regime as S9 WeakMap/Map/Set).
// peq binding is const; contents are mutated inside myers_32/myers_x. Engine has no structural
// property defeated by mutation-through-a-const-binding.
const peq = new Uint32Array(0x10000);
const myers_32 = (a, b) => {
    const n = a.length;
    const m = b.length;
    const lst = 1 << (n - 1);
    let pv = -1;
    let mv = 0;
    let sc = n;
    let i = n;
    while (i--) {
        peq[a.charCodeAt(i)] |= 1 << i;
    }
    for (i = 0; i < m; i++) {
        let eq = peq[b.charCodeAt(i)];
        const xv = eq | mv;
        eq |= ((eq & pv) + pv) ^ pv;
        mv |= ~(eq | pv);
        pv &= eq;
        if (mv & lst) {
            sc++;
        }
        if (pv & lst) {
            sc--;
        }
        mv = (mv << 1) | 1;
        pv = (pv << 1) | ~(xv | mv);
        mv &= xv;
    }
    i = n;
    while (i--) {
        peq[a.charCodeAt(i)] = 0;
    }
    return sc;
};
const myers_x = (b, a) => {
    const n = a.length;
    const m = b.length;
    const mhc = [];
    const phc = [];
    const hsize = Math.ceil(n / 32);
    const vsize = Math.ceil(m / 32);
    for (let i = 0; i < hsize; i++) {
        phc[i] = -1;
        mhc[i] = 0;
    }
    let j = 0;
    for (; j < vsize - 1; j++) {
        let mv = 0;
        let pv = -1;
        const start = j * 32;
        const vlen = Math.min(32, m) + start;
        for (let k = start; k < vlen; k++) {
            peq[b.charCodeAt(k)] |= 1 << k;
        }
        for (let i = 0; i < n; i++) {
            const eq = peq[a.charCodeAt(i)];
            const pb = (phc[(i / 32) | 0] >>> i) & 1;
            const mb = (mhc[(i / 32) | 0] >>> i) & 1;
            const xv = eq | mv;
            const xh = ((((eq | mb) & pv) + pv) ^ pv) | eq | mb;
            let ph = mv | ~(xh | pv);
            let mh = pv & xh;
            if ((ph >>> 31) ^ pb) {
                phc[(i / 32) | 0] ^= 1 << i;
            }
            if ((mh >>> 31) ^ mb) {
                mhc[(i / 32) | 0] ^= 1 << i;
            }
            ph = (ph << 1) | pb;
            mh = (mh << 1) | mb;
            pv = mh | ~(xv | ph);
            mv = ph & xv;
        }
        for (let k = start; k < vlen; k++) {
            peq[b.charCodeAt(k)] = 0;
        }
    }
    let mv = 0;
    let pv = -1;
    const start = j * 32;
    const vlen = Math.min(32, m - start) + start;
    for (let k = start; k < vlen; k++) {
        peq[b.charCodeAt(k)] |= 1 << k;
    }
    let score = m;
    for (let i = 0; i < n; i++) {
        const eq = peq[a.charCodeAt(i)];
        const pb = (phc[(i / 32) | 0] >>> i) & 1;
        const mb = (mhc[(i / 32) | 0] >>> i) & 1;
        const xv = eq | mv;
        const xh = ((((eq | mb) & pv) + pv) ^ pv) | eq | mb;
        let ph = mv | ~(xh | pv);
        let mh = pv & xh;
        score += (ph >>> (m - 1)) & 1;
        score -= (mh >>> (m - 1)) & 1;
        if ((ph >>> 31) ^ pb) {
            phc[(i / 32) | 0] ^= 1 << i;
        }
        if ((mh >>> 31) ^ mb) {
            mhc[(i / 32) | 0] ^= 1 << i;
        }
        ph = (ph << 1) | pb;
        mh = (mh << 1) | mb;
        pv = mh | ~(xv | ph);
        mv = ph & xv;
    }
    for (let k = start; k < vlen; k++) {
        peq[b.charCodeAt(k)] = 0;
    }
    return score;
};
const distance = (a, b) => {
    if (a.length < b.length) {
        const tmp = b;
        b = a;
        a = tmp;
    }
    if (b.length === 0) {
        return a.length;
    }
    if (a.length <= 32) {
        return myers_32(a, b);
    }
    return myers_x(a, b);
};
const closest = (str, arr) => {
    let min_distance = Infinity;
    let min_index = 0;
    for (let i = 0; i < arr.length; i++) {
        const dist = distance(str, arr[i]);
        if (dist < min_distance) {
            min_distance = dist;
            min_index = i;
        }
    }
    return arr[min_index];
};
export { closest, distance };
