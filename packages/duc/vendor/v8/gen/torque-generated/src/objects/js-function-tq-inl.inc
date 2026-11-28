// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=5&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction<D, P>::TorqueGeneratedJSFunctionOrBoundFunctionOrWrappedFunction(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsJSFunctionOrBoundFunctionOrWrappedFunction_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=35&c=29
template<class D, class P>
Tagged<Code> TorqueGeneratedJSFunction<D, P>::code() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSFunction::code(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=35&c=29
template<class D, class P>
Tagged<Code> TorqueGeneratedJSFunction<D, P>::code(PtrComprCageBase cage_base) const {
  Tagged<Code> value = TaggedField<Tagged<Code>>::load(cage_base, *this, kCodeOffset);
  DCHECK(IsCode(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=35&c=29
template<class D, class P>
void TorqueGeneratedJSFunction<D, P>::set_code(Tagged<Code> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsCode(value));
  WRITE_FIELD(*this, kCodeOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kCodeOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=36&c=3
template<class D, class P>
Tagged<SharedFunctionInfo> TorqueGeneratedJSFunction<D, P>::shared_function_info() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSFunction::shared_function_info(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=36&c=3
template<class D, class P>
Tagged<SharedFunctionInfo> TorqueGeneratedJSFunction<D, P>::shared_function_info(PtrComprCageBase cage_base) const {
  Tagged<SharedFunctionInfo> value = TaggedField<Tagged<SharedFunctionInfo>>::load(cage_base, *this, kSharedFunctionInfoOffset);
  DCHECK(IsSharedFunctionInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=36&c=3
template<class D, class P>
void TorqueGeneratedJSFunction<D, P>::set_shared_function_info(Tagged<SharedFunctionInfo> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsSharedFunctionInfo(value));
  WRITE_FIELD(*this, kSharedFunctionInfoOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kSharedFunctionInfoOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=37&c=3
template<class D, class P>
Tagged<Context> TorqueGeneratedJSFunction<D, P>::context() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSFunction::context(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=37&c=3
template<class D, class P>
Tagged<Context> TorqueGeneratedJSFunction<D, P>::context(PtrComprCageBase cage_base) const {
  Tagged<Context> value = TaggedField<Tagged<Context>>::load(cage_base, *this, kContextOffset);
  DCHECK(IsContext(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=37&c=3
template<class D, class P>
void TorqueGeneratedJSFunction<D, P>::set_context(Tagged<Context> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsContext(value));
  WRITE_FIELD(*this, kContextOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kContextOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=38&c=3
template<class D, class P>
Tagged<FeedbackCell> TorqueGeneratedJSFunction<D, P>::feedback_cell() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSFunction::feedback_cell(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=38&c=3
template<class D, class P>
Tagged<FeedbackCell> TorqueGeneratedJSFunction<D, P>::feedback_cell(PtrComprCageBase cage_base) const {
  Tagged<FeedbackCell> value = TaggedField<Tagged<FeedbackCell>>::load(cage_base, *this, kFeedbackCellOffset);
  DCHECK(IsFeedbackCell(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=38&c=3
template<class D, class P>
void TorqueGeneratedJSFunction<D, P>::set_feedback_cell(Tagged<FeedbackCell> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsFeedbackCell(value));
  WRITE_FIELD(*this, kFeedbackCellOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kFeedbackCellOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=40&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedJSFunction<D, P>::prototype_or_initial_map() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSFunction::prototype_or_initial_map(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=40&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedJSFunction<D, P>::prototype_or_initial_map(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kPrototypeOrInitialMapOffset);
  DCHECK(IsJSReceiver(value) || IsMap(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=40&c=3
template<class D, class P>
void TorqueGeneratedJSFunction<D, P>::set_prototype_or_initial_map(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSReceiver(value) || IsMap(value));
  WRITE_FIELD(*this, kPrototypeOrInitialMapOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPrototypeOrInitialMapOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=30&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedJSFunction<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedJSFunction<D, P>::TorqueGeneratedJSFunction(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsJSFunction_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=11&c=3
template<class D, class P>
Tagged<JSReceiver> TorqueGeneratedJSBoundFunction<D, P>::bound_target_function() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSBoundFunction::bound_target_function(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=11&c=3
template<class D, class P>
Tagged<JSReceiver> TorqueGeneratedJSBoundFunction<D, P>::bound_target_function(PtrComprCageBase cage_base) const {
  Tagged<JSReceiver> value = TaggedField<Tagged<JSReceiver>>::load(cage_base, *this, kBoundTargetFunctionOffset);
  DCHECK(IsJSFunction(value) || IsCallableApiObject(value) || IsCallableJSProxy(value) || IsJSBoundFunction(value) || IsJSWrappedFunction(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=11&c=3
template<class D, class P>
void TorqueGeneratedJSBoundFunction<D, P>::set_bound_target_function(Tagged<JSReceiver> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSFunction(value) || IsCallableApiObject(value) || IsCallableJSProxy(value) || IsJSBoundFunction(value) || IsJSWrappedFunction(value));
  WRITE_FIELD(*this, kBoundTargetFunctionOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kBoundTargetFunctionOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=14&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedJSBoundFunction<D, P>::bound_this() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSBoundFunction::bound_this(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=14&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedJSBoundFunction<D, P>::bound_this(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kBoundThisOffset);
  DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value) || IsSourceTextModule(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=14&c=3
template<class D, class P>
void TorqueGeneratedJSBoundFunction<D, P>::set_bound_this(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value) || IsSourceTextModule(value));
  WRITE_FIELD(*this, kBoundThisOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kBoundThisOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=17&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedJSBoundFunction<D, P>::bound_arguments() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSBoundFunction::bound_arguments(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=17&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedJSBoundFunction<D, P>::bound_arguments(PtrComprCageBase cage_base) const {
  Tagged<FixedArray> value = TaggedField<Tagged<FixedArray>>::load(cage_base, *this, kBoundArgumentsOffset);
  DCHECK(IsFixedArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=17&c=3
template<class D, class P>
void TorqueGeneratedJSBoundFunction<D, P>::set_bound_arguments(Tagged<FixedArray> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsFixedArray(value));
  WRITE_FIELD(*this, kBoundArgumentsOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kBoundArgumentsOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=8&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedJSBoundFunction<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedJSBoundFunction<D, P>::TorqueGeneratedJSBoundFunction(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsJSBoundFunction_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=23&c=3
template<class D, class P>
Tagged<JSReceiver> TorqueGeneratedJSWrappedFunction<D, P>::wrapped_target_function() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSWrappedFunction::wrapped_target_function(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=23&c=3
template<class D, class P>
Tagged<JSReceiver> TorqueGeneratedJSWrappedFunction<D, P>::wrapped_target_function(PtrComprCageBase cage_base) const {
  Tagged<JSReceiver> value = TaggedField<Tagged<JSReceiver>>::load(cage_base, *this, kWrappedTargetFunctionOffset);
  DCHECK(IsJSFunction(value) || IsCallableApiObject(value) || IsCallableJSProxy(value) || IsJSBoundFunction(value) || IsJSWrappedFunction(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=23&c=3
template<class D, class P>
void TorqueGeneratedJSWrappedFunction<D, P>::set_wrapped_target_function(Tagged<JSReceiver> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSFunction(value) || IsCallableApiObject(value) || IsCallableJSProxy(value) || IsJSBoundFunction(value) || IsJSWrappedFunction(value));
  WRITE_FIELD(*this, kWrappedTargetFunctionOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kWrappedTargetFunctionOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=25&c=3
template<class D, class P>
Tagged<NativeContext> TorqueGeneratedJSWrappedFunction<D, P>::context() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSWrappedFunction::context(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=25&c=3
template<class D, class P>
Tagged<NativeContext> TorqueGeneratedJSWrappedFunction<D, P>::context(PtrComprCageBase cage_base) const {
  Tagged<NativeContext> value = TaggedField<Tagged<NativeContext>>::load(cage_base, *this, kContextOffset);
  DCHECK(IsNativeContext(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=25&c=3
template<class D, class P>
void TorqueGeneratedJSWrappedFunction<D, P>::set_context(Tagged<NativeContext> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsNativeContext(value));
  WRITE_FIELD(*this, kContextOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kContextOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-function.tq?l=20&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedJSWrappedFunction<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedJSWrappedFunction<D, P>::TorqueGeneratedJSWrappedFunction(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsJSWrappedFunction_NonInline(*this));
}
