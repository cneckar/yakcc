class JSFunctionOrBoundFunctionOrWrappedFunction;
class JSFunction;
class JSBoundFunction;
class JSWrappedFunction;
// Alias for IsJSFunctionOrBoundFunctionOrWrappedFunction() that avoids inlining.
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=5&c=1
V8_EXPORT_PRIVATE bool IsJSFunctionOrBoundFunctionOrWrappedFunction_NonInline(Tagged<HeapObject> o);

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=5&c=1
template <class D, class P>
class TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction : public P {
  static_assert(
      std::is_same<JSFunctionOrBoundFunctionOrWrappedFunction, D>::value,
      "Use this class as direct base for JSFunctionOrBoundFunctionOrWrappedFunction.");
  static_assert(
      std::is_same<JSObject, P>::value,
      "Pass in JSObject as second template parameter for TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction<D,P>;

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=5&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=5&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

#ifdef VERIFY_HEAP
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=5&c=1
  V8_EXPORT_PRIVATE void JSFunctionOrBoundFunctionOrWrappedFunctionVerify(Isolate* isolate);
#endif  // VERIFY_HEAP

  static constexpr int kStartOfWeakFieldsOffset = P::kHeaderSize;
  static constexpr int kEndOfWeakFieldsOffset = P::kHeaderSize;
  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  static constexpr int kEndOfStrongFieldsOffset = P::kHeaderSize;
  static constexpr int kHeaderSize = P::kHeaderSize;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction, DAlias>::value,
        "class TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction should be used as direct base for JSFunctionOrBoundFunctionOrWrappedFunction.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction(Address ptr);
};

// Alias for IsJSFunction() that avoids inlining.
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=30&c=1
V8_EXPORT_PRIVATE bool IsJSFunction_NonInline(Tagged<HeapObject> o);

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=30&c=1
template <class D, class P>
class TorqueGeneratedJSFunction : public P {
  static_assert(
      std::is_same<JSFunction, D>::value,
      "Use this class as direct base for JSFunction.");
  static_assert(
      std::is_same<JSFunctionOrBoundFunctionOrWrappedFunction, P>::value,
      "Pass in JSFunctionOrBoundFunctionOrWrappedFunction as second template parameter for TorqueGeneratedJSFunction.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSFunction<D,P>;

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=35&c=29
  inline Tagged<Code> code() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=35&c=29
  inline Tagged<Code> code(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=35&c=29
  inline void set_code(Tagged<Code> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=36&c=3
  inline Tagged<SharedFunctionInfo> shared_function_info() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=36&c=3
  inline Tagged<SharedFunctionInfo> shared_function_info(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=36&c=3
  inline void set_shared_function_info(Tagged<SharedFunctionInfo> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=37&c=3
  inline Tagged<Context> context() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=37&c=3
  inline Tagged<Context> context(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=37&c=3
  inline void set_context(Tagged<Context> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=38&c=3
  inline Tagged<FeedbackCell> feedback_cell() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=38&c=3
  inline Tagged<FeedbackCell> feedback_cell(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=38&c=3
  inline void set_feedback_cell(Tagged<FeedbackCell> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: (class JSReceiver | class Map)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=40&c=3
  inline Tagged<HeapObject> prototype_or_initial_map() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=40&c=3
  inline Tagged<HeapObject> prototype_or_initial_map(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=40&c=3
  inline void set_prototype_or_initial_map(Tagged<HeapObject> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=30&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=30&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(JSFunction)

#ifdef VERIFY_HEAP
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=30&c=1
  V8_EXPORT_PRIVATE void JSFunctionVerify(Isolate* isolate);
#endif  // VERIFY_HEAP

  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=35&c=29
  static constexpr int kCodeOffset = P::kHeaderSize;
  static constexpr int kCodeOffsetEnd = kCodeOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=36&c=3
  static constexpr int kSharedFunctionInfoOffset = kCodeOffsetEnd + 1;
  static constexpr int kSharedFunctionInfoOffsetEnd = kSharedFunctionInfoOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=37&c=3
  static constexpr int kContextOffset = kSharedFunctionInfoOffsetEnd + 1;
  static constexpr int kContextOffsetEnd = kContextOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=38&c=3
  static constexpr int kFeedbackCellOffset = kContextOffsetEnd + 1;
  static constexpr int kFeedbackCellOffsetEnd = kFeedbackCellOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=40&c=3
  static constexpr int kPrototypeOrInitialMapOffset = kFeedbackCellOffsetEnd + 1;
  static constexpr int kPrototypeOrInitialMapOffsetEnd = kPrototypeOrInitialMapOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kPrototypeOrInitialMapOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kPrototypeOrInitialMapOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kPrototypeOrInitialMapOffsetEnd + 1;
  static constexpr int kHeaderSize = kPrototypeOrInitialMapOffsetEnd + 1;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSFunction() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSFunction, DAlias>::value,
        "class TorqueGeneratedJSFunction should be used as direct base for JSFunction.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSFunction(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSFunction(Address ptr);
};

// Alias for IsJSBoundFunction() that avoids inlining.
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=8&c=1
V8_EXPORT_PRIVATE bool IsJSBoundFunction_NonInline(Tagged<HeapObject> o);

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=8&c=1
template <class D, class P>
class TorqueGeneratedJSBoundFunction : public P {
  static_assert(
      std::is_same<JSBoundFunction, D>::value,
      "Use this class as direct base for JSBoundFunction.");
  static_assert(
      std::is_same<JSFunctionOrBoundFunctionOrWrappedFunction, P>::value,
      "Pass in JSFunctionOrBoundFunctionOrWrappedFunction as second template parameter for TorqueGeneratedJSBoundFunction.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSBoundFunction<D,P>;

  // Torque type: Callable
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=11&c=3
  inline Tagged<JSReceiver> bound_target_function() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=11&c=3
  inline Tagged<JSReceiver> bound_target_function(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=11&c=3
  inline void set_bound_target_function(Tagged<JSReceiver> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: (class JSReceiver | Smi | class HeapNumber | BigInt | class String | class Symbol | class Boolean | class Null | class Undefined | class SourceTextModule)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=14&c=3
  inline Tagged<Object> bound_this() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=14&c=3
  inline Tagged<Object> bound_this(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=14&c=3
  inline void set_bound_this(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=17&c=3
  inline Tagged<FixedArray> bound_arguments() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=17&c=3
  inline Tagged<FixedArray> bound_arguments(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=17&c=3
  inline void set_bound_arguments(Tagged<FixedArray> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=8&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=8&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(JSBoundFunction)

#ifdef VERIFY_HEAP
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=8&c=1
  V8_EXPORT_PRIVATE void JSBoundFunctionVerify(Isolate* isolate);
#endif  // VERIFY_HEAP

  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=11&c=3
  static constexpr int kBoundTargetFunctionOffset = P::kHeaderSize;
  static constexpr int kBoundTargetFunctionOffsetEnd = kBoundTargetFunctionOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=14&c=3
  static constexpr int kBoundThisOffset = kBoundTargetFunctionOffsetEnd + 1;
  static constexpr int kBoundThisOffsetEnd = kBoundThisOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=17&c=3
  static constexpr int kBoundArgumentsOffset = kBoundThisOffsetEnd + 1;
  static constexpr int kBoundArgumentsOffsetEnd = kBoundArgumentsOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kBoundArgumentsOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kBoundArgumentsOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kBoundArgumentsOffsetEnd + 1;
  static constexpr int kHeaderSize = kBoundArgumentsOffsetEnd + 1;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSBoundFunction() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSBoundFunction, DAlias>::value,
        "class TorqueGeneratedJSBoundFunction should be used as direct base for JSBoundFunction.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSBoundFunction(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSBoundFunction(Address ptr);
};

// Alias for IsJSWrappedFunction() that avoids inlining.
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=20&c=1
V8_EXPORT_PRIVATE bool IsJSWrappedFunction_NonInline(Tagged<HeapObject> o);

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=20&c=1
template <class D, class P>
class TorqueGeneratedJSWrappedFunction : public P {
  static_assert(
      std::is_same<JSWrappedFunction, D>::value,
      "Use this class as direct base for JSWrappedFunction.");
  static_assert(
      std::is_same<JSFunctionOrBoundFunctionOrWrappedFunction, P>::value,
      "Pass in JSFunctionOrBoundFunctionOrWrappedFunction as second template parameter for TorqueGeneratedJSWrappedFunction.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedJSWrappedFunction<D,P>;

  // Torque type: Callable
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=23&c=3
  inline Tagged<JSReceiver> wrapped_target_function() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=23&c=3
  inline Tagged<JSReceiver> wrapped_target_function(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=23&c=3
  inline void set_wrapped_target_function(Tagged<JSReceiver> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=25&c=3
  inline Tagged<NativeContext> context() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=25&c=3
  inline Tagged<NativeContext> context(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=25&c=3
  inline void set_context(Tagged<NativeContext> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=20&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=20&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(JSWrappedFunction)

#ifdef VERIFY_HEAP
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=20&c=1
  V8_EXPORT_PRIVATE void JSWrappedFunctionVerify(Isolate* isolate);
#endif  // VERIFY_HEAP

  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=23&c=3
  static constexpr int kWrappedTargetFunctionOffset = P::kHeaderSize;
  static constexpr int kWrappedTargetFunctionOffsetEnd = kWrappedTargetFunctionOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=25&c=3
  static constexpr int kContextOffset = kWrappedTargetFunctionOffsetEnd + 1;
  static constexpr int kContextOffsetEnd = kContextOffset + kTaggedSize - 1;
  static constexpr int kEndOfStrongFieldsOffset = kContextOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kContextOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kContextOffsetEnd + 1;
  static constexpr int kHeaderSize = kContextOffsetEnd + 1;

  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedJSWrappedFunction() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedJSWrappedFunction, DAlias>::value,
        "class TorqueGeneratedJSWrappedFunction should be used as direct base for JSWrappedFunction.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedJSWrappedFunction(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedJSWrappedFunction(Address ptr);
};

