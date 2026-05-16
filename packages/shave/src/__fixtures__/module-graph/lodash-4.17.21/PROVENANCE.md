# Provenance — lodash@4.17.21 fixture (TRIMMED)

- **Package:** lodash
- **Version:** 4.17.21 (NOT the current `latest` 4.18.1; see DEC-WI510-S7-VERSION-PIN-001)
- **Source:** npm tarball (`npm pack lodash@4.17.21`)
- **Tarball SHA1:** 679591c564c3bffaae8454cf0b3df370c3d6911c
- **Tarball integrity:** sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==
- **Tarball file count:** 1054
- **Tarball unpacked bytes:** 1413741
- **Retrieved:** 2026-05-16
- **Vendor strategy:** TRIMMED (NOT full-tarball as Slices 3/4/6 used).
  Rationale: the full tarball is ~1.4MB across 1054 files; only 148 are transitively
  reachable from the six Slice 7 headline subgraphs. Trimmed vendor retains those
  148 files + package.json + LICENSE. Trimmed size: ~120KB total.
  Inherits Slice 5 rationale (DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001) extended to
  lodash via DEC-WI510-S7-FIXTURE-TRIMMED-VENDOR-001.
- **Retained files (148 .js + package.json + LICENSE + this PROVENANCE.md):**
  Headlines: cloneDeep.js, debounce.js, throttle.js, get.js, set.js, merge.js.
  Shared transitives: _DataView.js, _Hash.js, _ListCache.js, _Map.js, _MapCache.js,
  _Promise.js, _Set.js, _Stack.js, _Symbol.js, _Uint8Array.js, _WeakMap.js, _apply.js,
  _arrayEach.js, _arrayFilter.js, _arrayLikeKeys.js, _arrayMap.js, _arrayPush.js,
  _assignMergeValue.js, _assignValue.js, _assocIndexOf.js, _baseAssign.js, _baseAssignIn.js,
  _baseAssignValue.js, _baseClone.js, _baseCreate.js, _baseFor.js, _baseGet.js,
  _baseGetAllKeys.js, _baseGetTag.js, _baseIsArguments.js, _baseIsMap.js, _baseIsNative.js,
  _baseIsSet.js, _baseIsTypedArray.js, _baseKeys.js, _baseKeysIn.js, _baseMerge.js,
  _baseMergeDeep.js, _baseRest.js, _baseSet.js, _baseSetToString.js, _baseTimes.js,
  _baseToString.js, _baseTrim.js, _baseUnary.js, _castPath.js, _cloneArrayBuffer.js,
  _cloneBuffer.js, _cloneDataView.js, _cloneRegExp.js, _cloneSymbol.js, _cloneTypedArray.js,
  _copyArray.js, _copyObject.js, _copySymbols.js, _copySymbolsIn.js, _coreJsData.js,
  _createAssigner.js, _createBaseFor.js, _defineProperty.js, _freeGlobal.js, _getAllKeys.js,
  _getAllKeysIn.js, _getMapData.js, _getNative.js, _getPrototype.js, _getRawTag.js,
  _getSymbols.js, _getSymbolsIn.js, _getTag.js, _getValue.js, _hashClear.js, _hashDelete.js,
  _hashGet.js, _hashHas.js, _hashSet.js, _initCloneArray.js, _initCloneByTag.js,
  _initCloneObject.js, _isIndex.js, _isIterateeCall.js, _isKey.js, _isKeyable.js,
  _isMasked.js, _isPrototype.js, _listCacheClear.js, _listCacheDelete.js, _listCacheGet.js,
  _listCacheHas.js, _listCacheSet.js, _mapCacheClear.js, _mapCacheDelete.js, _mapCacheGet.js,
  _mapCacheHas.js, _mapCacheSet.js, _memoizeCapped.js, _nativeCreate.js, _nativeKeys.js,
  _nativeKeysIn.js, _nodeUtil.js, _objectToString.js, _overArg.js, _overRest.js, _root.js,
  _safeGet.js, _setToString.js, _shortOut.js, _stackClear.js, _stackDelete.js, _stackGet.js,
  _stackHas.js, _stackSet.js, _stringToPath.js, _toKey.js, _toSource.js, _trimmedEndIndex.js,
  constant.js, eq.js, identity.js, isArguments.js, isArray.js, isArrayLike.js,
  isArrayLikeObject.js, isBuffer.js, isFunction.js, isLength.js, isMap.js, isObject.js,
  isObjectLike.js, isPlainObject.js, isSet.js, isSymbol.js, isTypedArray.js, keys.js,
  keysIn.js, memoize.js, now.js, stubArray.js, stubFalse.js, toNumber.js, toPlainObject.js,
  toString.js.
- **Excluded files / directories (deliberately NOT vendored):**
  - lodash.js (17,000-line UMD bundle — never traversed by Slice 7; see DEC-WI510-S7-MODULAR-NOT-BUNDLED-001)
  - core.js, core.min.js, lodash.min.js (browser bundles)
  - fp/ (auto-curried functional wrappers, ~330 files)
  - ~480 other public binding .js files (add, after, chunk, compact, flatten, pick, ...)
  - ~330 _<helper>.js internal files used only by the excluded bindings
  - README.md
- **Shape:** Pure modern Node.js CommonJS. Every .js opens with top-of-file `var x = require('./<rel>')`
  declarations followed by `function name(...) {}` and `module.exports = name;`. NOT
  Babel-transpiled. NOT TypeScript-compiled. NOT IIFE-wrapped (the modular files are NOT UMD;
  the UMD bundle is in the excluded lodash.js).
- **Runtime dependencies:** none (`package.json#dependencies` is empty / absent).
- **External edges (visible to engine):** none. _nodeUtil.js (a transitive of cloneDeep + merge)
  contains a `freeModule.require('util')` indirect property-access call, NOT a bare `require('util')`;
  the engine's extractRequireSpecifiers skips it by design (DEC-WI510-S7-EXTERNAL-SPECIFIERS-EMPTY-001).
  Expected `stubCount = 0` and `externalSpecifiers = []` for ALL six Slice 7 headlines.
- **Headline behaviors (this slice):** cloneDeep, debounce, throttle, get, set, merge —
  each one a distinct entryPath shave producing its own atom merkle root. No collapses,
  no substitutions (per plan §1.1 — modular lodash gives every binding its own file).
- **Path decision:** Modular (a), not bundled (b) — per DEC-WI510-S7-MODULAR-NOT-BUNDLED-001.
- **Why pin 4.17.21:** Universally-deployed CJS-friendly version; ~30M weekly downloads;
  the version every npm lockfile in the world currently resolves to. Modular layout
  identical to 4.18.1 for the six target bindings (DEC-WI510-S7-VERSION-PIN-001).
- **WI:** WI-510 Slice 7, workflow `wi-510-s7-lodash`.
