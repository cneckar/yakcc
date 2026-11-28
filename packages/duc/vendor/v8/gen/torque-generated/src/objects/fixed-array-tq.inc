class WeakArrayList;
// Alias for IsWeakArrayList() that avoids inlining.
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
V8_EXPORT_PRIVATE bool IsWeakArrayList_NonInline(Tagged<HeapObject> o);

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
template <class D, class P>
class TorqueGeneratedWeakArrayList : public P {
  static_assert(
      std::is_same<WeakArrayList, D>::value,
      "Use this class as direct base for WeakArrayList.");
  static_assert(
      std::is_same<HeapObject, P>::value,
      "Pass in HeapObject as second template parameter for TorqueGeneratedWeakArrayList.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedWeakArrayList<D,P>;

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=69&c=9
  inline int capacity() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=69&c=9
  inline void set_capacity(int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=70&c=3
  inline int length() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=70&c=3
  inline void set_length(int value);

  // Torque type: MaybeObject
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
  inline Tagged<MaybeObject> objects(int i, RelaxedLoadTag) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
  inline Tagged<MaybeObject> objects(PtrComprCageBase cage_base, int i, RelaxedLoadTag) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
  inline void set_objects(int i, Tagged<MaybeObject> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(WeakArrayList)

#ifdef VERIFY_HEAP
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
  V8_EXPORT_PRIVATE void WeakArrayListVerify(Isolate* isolate);
#endif  // VERIFY_HEAP

  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=69&c=9
  static constexpr int kCapacityOffset = P::kHeaderSize;
  static constexpr int kCapacityOffsetEnd = kCapacityOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=70&c=3
  static constexpr int kLengthOffset = kCapacityOffsetEnd + 1;
  static constexpr int kLengthOffsetEnd = kLengthOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kLengthOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kLengthOffsetEnd + 1;
  static constexpr int kHeaderSize = kLengthOffsetEnd + 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
  static constexpr int kObjectsOffset = kLengthOffsetEnd + 1;
  static constexpr int kObjectsOffsetEnd = kObjectsOffset + 0 - 1;
  static constexpr int kEndOfWeakFieldsOffset = kObjectsOffsetEnd + 1;

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
  V8_INLINE static constexpr int32_t SizeFor(int capacity) {
    int32_t size = kHeaderSize;
    size += capacity * 8;
    return size;
  }

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
  V8_INLINE int32_t AllocatedSize() const {
    return SizeFor(this->capacity());
  }

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedWeakArrayList() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedWeakArrayList, DAlias>::value,
        "class TorqueGeneratedWeakArrayList should be used as direct base for WeakArrayList.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedWeakArrayList(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedWeakArrayList(Address ptr);
};

