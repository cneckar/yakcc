class JSRegExp;
class JSRegExpResult;
class JSRegExpResultWithIndices;
class JSRegExpResultIndices;
// Alias for IsJSRegExp() that avoids inlining.
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=17&c=1
V8_EXPORT_PRIVATE bool IsJSRegExp_NonInline(Tagged<HeapObject> o);

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=17&c=1
template <class D, class P>
class TorqueGeneratedJSRegExp : public P {
  static_assert(
      std::is_same<JSRegExp, D>::value,
      "Use this class as direct base for JSRegExp.");
  static_assert(
      std::is_same<JSObject, P>::value,
      "Pass in JSObject as second template parameter for TorqueGeneratedJSRegExp.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSRegExp<D,P>;

  // Torque type: (class Undefined | class FixedArray)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=18&c=3
  inline Tagged<HeapObject> data() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=18&c=3
  inline Tagged<HeapObject> data(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=18&c=3
  inline void set_data(Tagged<HeapObject> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: (class String | class Undefined)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=19&c=3
  inline Tagged<PrimitiveHeapObject> source() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=19&c=3
  inline Tagged<PrimitiveHeapObject> source(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=19&c=3
  inline void set_source(Tagged<PrimitiveHeapObject> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: (class Undefined | SmiTagged<bitfield struct JSRegExpFlags>)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=20&c=3
  inline Tagged<Object> flags() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=20&c=3
  inline Tagged<Object> flags(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=20&c=3
  inline void set_flags(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=17&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=17&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(JSRegExp)

#ifdef VERIFY_HEAP
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=17&c=1
  V8_EXPORT_PRIVATE void JSRegExpVerify(Isolate* isolate);
#endif  // VERIFY_HEAP

  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=18&c=3
  static constexpr int kDataOffset = P::kHeaderSize;
  static constexpr int kDataOffsetEnd = kDataOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=19&c=3
  static constexpr int kSourceOffset = kDataOffsetEnd + 1;
  static constexpr int kSourceOffsetEnd = kSourceOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=20&c=3
  static constexpr int kFlagsOffset = kSourceOffsetEnd + 1;
  static constexpr int kFlagsOffsetEnd = kFlagsOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kFlagsOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kFlagsOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kFlagsOffsetEnd + 1;
  static constexpr int kHeaderSize = kFlagsOffsetEnd + 1;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSRegExp() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSRegExp, DAlias>::value,
        "class TorqueGeneratedJSRegExp should be used as direct base for JSRegExp.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSRegExp(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSRegExp(Address ptr);
};

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=44&c=1
template <class D, class P>
class TorqueGeneratedJSRegExpResult : public P {
  static_assert(
      std::is_same<JSRegExpResult, D>::value,
      "Use this class as direct base for JSRegExpResult.");
  static_assert(
      std::is_same<JSArray, P>::value,
      "Pass in JSArray as second template parameter for TorqueGeneratedJSRegExpResult.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSRegExpResult<D,P>;

  // Torque type: JSAny
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=47&c=3
  inline Tagged<Object> index() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=47&c=3
  inline Tagged<Object> index(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=47&c=3
  inline void set_index(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: JSAny
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=48&c=3
  inline Tagged<Object> input() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=48&c=3
  inline Tagged<Object> input(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=48&c=3
  inline void set_input(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: JSAny
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=49&c=3
  inline Tagged<Object> groups() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=49&c=3
  inline Tagged<Object> groups(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=49&c=3
  inline void set_groups(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: (class Undefined | class FixedArray)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=52&c=3
  inline Tagged<HeapObject> names() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=52&c=3
  inline Tagged<HeapObject> names(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=52&c=3
  inline void set_names(Tagged<HeapObject> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=53&c=3
  inline Tagged<String> regexp_input() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=53&c=3
  inline Tagged<String> regexp_input(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=53&c=3
  inline void set_regexp_input(Tagged<String> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=54&c=3
  inline int regexp_last_index() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=54&c=3
  inline void set_regexp_last_index(int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=44&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=44&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(JSRegExpResult)


  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=47&c=3
  static constexpr int kIndexOffset = P::kHeaderSize;
  static constexpr int kIndexOffsetEnd = kIndexOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=48&c=3
  static constexpr int kInputOffset = kIndexOffsetEnd + 1;
  static constexpr int kInputOffsetEnd = kInputOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=49&c=3
  static constexpr int kGroupsOffset = kInputOffsetEnd + 1;
  static constexpr int kGroupsOffsetEnd = kGroupsOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=52&c=3
  static constexpr int kNamesOffset = kGroupsOffsetEnd + 1;
  static constexpr int kNamesOffsetEnd = kNamesOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=53&c=3
  static constexpr int kRegexpInputOffset = kNamesOffsetEnd + 1;
  static constexpr int kRegexpInputOffsetEnd = kRegexpInputOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=54&c=3
  static constexpr int kRegexpLastIndexOffset = kRegexpInputOffsetEnd + 1;
  static constexpr int kRegexpLastIndexOffsetEnd = kRegexpLastIndexOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kRegexpLastIndexOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kRegexpLastIndexOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kRegexpLastIndexOffsetEnd + 1;
  static constexpr int kSize = kRegexpLastIndexOffsetEnd + 1;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSRegExpResult() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSRegExpResult, DAlias>::value,
        "class TorqueGeneratedJSRegExpResult should be used as direct base for JSRegExpResult.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSRegExpResult(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSRegExpResult(Address ptr);
};

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=57&c=1
template <class D, class P>
class TorqueGeneratedJSRegExpResultWithIndices : public P {
  static_assert(
      std::is_same<JSRegExpResultWithIndices, D>::value,
      "Use this class as direct base for JSRegExpResultWithIndices.");
  static_assert(
      std::is_same<JSRegExpResult, P>::value,
      "Pass in JSRegExpResult as second template parameter for TorqueGeneratedJSRegExpResultWithIndices.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSRegExpResultWithIndices<D,P>;

  // Torque type: JSAny
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=58&c=3
  inline Tagged<Object> indices() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=58&c=3
  inline Tagged<Object> indices(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=58&c=3
  inline void set_indices(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=57&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=57&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(JSRegExpResultWithIndices)


  static constexpr int kStartOfStrongFieldsOffset = P::kSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=58&c=3
  static constexpr int kIndicesOffset = P::kSize;
  static constexpr int kIndicesOffsetEnd = kIndicesOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kIndicesOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kIndicesOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kIndicesOffsetEnd + 1;
  static constexpr int kSize = kIndicesOffsetEnd + 1;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSRegExpResultWithIndices() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSRegExpResultWithIndices, DAlias>::value,
        "class TorqueGeneratedJSRegExpResultWithIndices should be used as direct base for JSRegExpResultWithIndices.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSRegExpResultWithIndices(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSRegExpResultWithIndices(Address ptr);
};

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=61&c=1
template <class D, class P>
class TorqueGeneratedJSRegExpResultIndices : public P {
  static_assert(
      std::is_same<JSRegExpResultIndices, D>::value,
      "Use this class as direct base for JSRegExpResultIndices.");
  static_assert(
      std::is_same<JSArray, P>::value,
      "Pass in JSArray as second template parameter for TorqueGeneratedJSRegExpResultIndices.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSRegExpResultIndices<D,P>;

  // Torque type: JSAny
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=64&c=3
  inline Tagged<Object> groups() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=64&c=3
  inline Tagged<Object> groups(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=64&c=3
  inline void set_groups(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=61&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=61&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(JSRegExpResultIndices)


  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-regexp.tq?l=64&c=3
  static constexpr int kGroupsOffset = P::kHeaderSize;
  static constexpr int kGroupsOffsetEnd = kGroupsOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kGroupsOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kGroupsOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kGroupsOffsetEnd + 1;
  static constexpr int kSize = kGroupsOffsetEnd + 1;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSRegExpResultIndices() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSRegExpResultIndices, DAlias>::value,
        "class TorqueGeneratedJSRegExpResultIndices should be used as direct base for JSRegExpResultIndices.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSRegExpResultIndices(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSRegExpResultIndices(Address ptr);
};

