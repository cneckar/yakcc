// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceCoverageInfoSlots(Tagged<CoverageInfo> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=73&c=1
inline intptr_t TqRuntimeFromConstexpr_intptr_constexpr_int31_0(int31_t p_i);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=204&c=1
inline intptr_t TqRuntimeConvert_intptr_int32_0(int32_t p_i);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=8&c=1
inline intptr_t TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral p_i);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_CoverageInfoSlot_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=79&c=1
inline intptr_t TqRuntimeFromConstexpr_intptr_constexpr_intptr_0(intptr_t p_i);

#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceCoverageInfoSlots
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceCoverageInfoSlots

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceCoverageInfoSlots(Tagged<CoverageInfo> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  int32_t tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = (p_o)->ReadField<int32_t>(tmp0);
  tmp2 = TqRuntimeConvert_intptr_int32_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0xcull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_CoverageInfoSlot_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceCoverageInfoSlots
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_int31_0
#define V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_int31_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=73&c=1
intptr_t TqRuntimeFromConstexpr_intptr_constexpr_int31_0(int31_t p_i) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  goto block0;

  block0:
  tmp0 = (CastToUnderlyingTypeIfEnum(p_i));
  goto block2;

  block2:
  return tmp0;
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_int31_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeConvert_intptr_int32_0
#define V8_INTERNAL_DEFINED_TqRuntimeConvert_intptr_int32_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=204&c=1
intptr_t TqRuntimeConvert_intptr_int32_0(int32_t p_i) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  goto block0;

  block0:
  tmp0 = TorqueRuntimeMacroShims::CodeStubAssembler::ChangeInt32ToIntPtr(p_i);
  goto block2;

  block2:
  return tmp0;
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeConvert_intptr_int32_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0
#define V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=8&c=1
intptr_t TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral p_i) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_intptr_0((TorqueRuntimeMacroShims::CodeStubAssembler::ConstexprIntegerLiteralToIntptr(p_i)));
  goto block2;

  block2:
  return tmp0;
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_CoverageInfoSlot_0
#define V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_CoverageInfoSlot_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_CoverageInfoSlot_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length) {
  DisallowGarbageCollection no_gc;
  Tagged<Object> tmp0{}; USE(tmp0);
  intptr_t tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  goto block0;

  block0:
  std::tie(tmp0, tmp1, tmp2) = (std::make_tuple(p_object, p_offset, p_length));
  goto block2;

  block2:
  return std::make_tuple(tmp0, tmp1, tmp2);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_CoverageInfoSlot_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_intptr_0
#define V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_intptr_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=79&c=1
intptr_t TqRuntimeFromConstexpr_intptr_constexpr_intptr_0(intptr_t p_i) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  goto block0;

  block0:
  tmp0 = (CastToUnderlyingTypeIfEnum(p_i));
  goto block2;

  block2:
  return tmp0;
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFromConstexpr_intptr_constexpr_intptr_0
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=6&c=3
template<class D, class P>
int TorqueGeneratedBreakPoint<D, P>::id() const {
  int value = TaggedField<Smi>::load(*this, kIdOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=6&c=3
template<class D, class P>
void TorqueGeneratedBreakPoint<D, P>::set_id(int value) {
  WRITE_FIELD(*this, kIdOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=7&c=3
template<class D, class P>
Tagged<String> TorqueGeneratedBreakPoint<D, P>::condition() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedBreakPoint::condition(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=7&c=3
template<class D, class P>
Tagged<String> TorqueGeneratedBreakPoint<D, P>::condition(PtrComprCageBase cage_base) const {
  Tagged<String> value = TaggedField<Tagged<String>>::load(cage_base, *this, kConditionOffset);
  DCHECK(IsString(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=7&c=3
template<class D, class P>
void TorqueGeneratedBreakPoint<D, P>::set_condition(Tagged<String> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsString(value));
  WRITE_FIELD(*this, kConditionOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kConditionOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=5&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedBreakPoint<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedBreakPoint<D, P>::TorqueGeneratedBreakPoint(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsBreakPoint_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=12&c=3
template<class D, class P>
int TorqueGeneratedBreakPointInfo<D, P>::source_position() const {
  int value = TaggedField<Smi>::load(*this, kSourcePositionOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=12&c=3
template<class D, class P>
void TorqueGeneratedBreakPointInfo<D, P>::set_source_position(int value) {
  WRITE_FIELD(*this, kSourcePositionOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=14&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedBreakPointInfo<D, P>::break_points() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedBreakPointInfo::break_points(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=14&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedBreakPointInfo<D, P>::break_points(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kBreakPointsOffset);
  DCHECK(IsUndefined(value) || IsFixedArray(value) || IsBreakPoint(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=14&c=3
template<class D, class P>
void TorqueGeneratedBreakPointInfo<D, P>::set_break_points(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFixedArray(value) || IsBreakPoint(value));
  WRITE_FIELD(*this, kBreakPointsOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kBreakPointsOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=10&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedBreakPointInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedBreakPointInfo<D, P>::TorqueGeneratedBreakPointInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsBreakPointInfo_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=34&c=3
template<class D, class P>
Tagged<SharedFunctionInfo> TorqueGeneratedDebugInfo<D, P>::shared() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedDebugInfo::shared(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=34&c=3
template<class D, class P>
Tagged<SharedFunctionInfo> TorqueGeneratedDebugInfo<D, P>::shared(PtrComprCageBase cage_base) const {
  Tagged<SharedFunctionInfo> value = TaggedField<Tagged<SharedFunctionInfo>>::load(cage_base, *this, kSharedOffset);
  DCHECK(IsSharedFunctionInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=34&c=3
template<class D, class P>
void TorqueGeneratedDebugInfo<D, P>::set_shared(Tagged<SharedFunctionInfo> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsSharedFunctionInfo(value));
  WRITE_FIELD(*this, kSharedOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kSharedOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=36&c=3
template<class D, class P>
int TorqueGeneratedDebugInfo<D, P>::debugger_hints() const {
  int value = TaggedField<Smi>::load(*this, kDebuggerHintsOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=36&c=3
template<class D, class P>
void TorqueGeneratedDebugInfo<D, P>::set_debugger_hints(int value) {
  WRITE_FIELD(*this, kDebuggerHintsOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=38&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedDebugInfo<D, P>::break_points() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedDebugInfo::break_points(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=38&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedDebugInfo<D, P>::break_points(PtrComprCageBase cage_base) const {
  Tagged<FixedArray> value = TaggedField<Tagged<FixedArray>>::load(cage_base, *this, kBreakPointsOffset);
  DCHECK(IsFixedArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=38&c=3
template<class D, class P>
void TorqueGeneratedDebugInfo<D, P>::set_break_points(Tagged<FixedArray> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsFixedArray(value));
  WRITE_FIELD(*this, kBreakPointsOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kBreakPointsOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=40&c=36
template<class D, class P>
int TorqueGeneratedDebugInfo<D, P>::flags(RelaxedLoadTag) const {
  int value = TaggedField<Smi>::Relaxed_Load(*this, kFlagsOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=40&c=36
template<class D, class P>
void TorqueGeneratedDebugInfo<D, P>::set_flags(int value, RelaxedStoreTag) {
  RELAXED_WRITE_FIELD(*this, kFlagsOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=41&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedDebugInfo<D, P>::coverage_info() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedDebugInfo::coverage_info(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=41&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedDebugInfo<D, P>::coverage_info(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kCoverageInfoOffset);
  DCHECK(IsUndefined(value) || IsCoverageInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=41&c=3
template<class D, class P>
void TorqueGeneratedDebugInfo<D, P>::set_coverage_info(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsCoverageInfo(value));
  WRITE_FIELD(*this, kCoverageInfoOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kCoverageInfoOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=46&c=40
template<class D, class P>
Tagged<Object> TorqueGeneratedDebugInfo<D, P>::original_bytecode_array(AcquireLoadTag) const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedDebugInfo::original_bytecode_array(cage_base, kAcquireLoad);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=46&c=40
template<class D, class P>
Tagged<Object> TorqueGeneratedDebugInfo<D, P>::original_bytecode_array(PtrComprCageBase cage_base, AcquireLoadTag) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::Acquire_Load(cage_base, *this, kOriginalBytecodeArrayOffset);
  DCHECK(IsSmi(value) || IsBytecodeArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=46&c=40
template<class D, class P>
void TorqueGeneratedDebugInfo<D, P>::set_original_bytecode_array(Tagged<Object> value, ReleaseStoreTag, WriteBarrierMode mode) {
  SLOW_DCHECK(IsSmi(value) || IsBytecodeArray(value));
  RELEASE_WRITE_FIELD(*this, kOriginalBytecodeArrayOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kOriginalBytecodeArrayOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=54&c=40
template<class D, class P>
Tagged<Object> TorqueGeneratedDebugInfo<D, P>::debug_bytecode_array(AcquireLoadTag) const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedDebugInfo::debug_bytecode_array(cage_base, kAcquireLoad);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=54&c=40
template<class D, class P>
Tagged<Object> TorqueGeneratedDebugInfo<D, P>::debug_bytecode_array(PtrComprCageBase cage_base, AcquireLoadTag) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::Acquire_Load(cage_base, *this, kDebugBytecodeArrayOffset);
  DCHECK(IsSmi(value) || IsBytecodeArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=54&c=40
template<class D, class P>
void TorqueGeneratedDebugInfo<D, P>::set_debug_bytecode_array(Tagged<Object> value, ReleaseStoreTag, WriteBarrierMode mode) {
  SLOW_DCHECK(IsSmi(value) || IsBytecodeArray(value));
  RELEASE_WRITE_FIELD(*this, kDebugBytecodeArrayOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kDebugBytecodeArrayOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=33&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedDebugInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedDebugInfo<D, P>::TorqueGeneratedDebugInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsDebugInfo_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=70&c=9
template<class D, class P>
int32_t TorqueGeneratedCoverageInfo<D, P>::slot_count() const {
  int32_t value = this->template ReadField<int32_t>(kSlotCountOffset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=70&c=9
template<class D, class P>
void TorqueGeneratedCoverageInfo<D, P>::set_slot_count(int32_t value) {
  this->template WriteField<int32_t>(kSlotCountOffset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
int32_t TorqueGeneratedCoverageInfo<D, P>::slots_start_source_position(int i) const {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 0 + i * 16;
  int32_t value = this->template ReadField<int32_t>(offset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
void TorqueGeneratedCoverageInfo<D, P>::set_slots_start_source_position(int i, int32_t value) {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 0 + i * 16;
  this->template WriteField<int32_t>(offset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
int32_t TorqueGeneratedCoverageInfo<D, P>::slots_end_source_position(int i) const {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 4 + i * 16;
  int32_t value = this->template ReadField<int32_t>(offset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
void TorqueGeneratedCoverageInfo<D, P>::set_slots_end_source_position(int i, int32_t value) {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 4 + i * 16;
  this->template WriteField<int32_t>(offset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
int32_t TorqueGeneratedCoverageInfo<D, P>::slots_block_count(int i) const {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 8 + i * 16;
  int32_t value = this->template ReadField<int32_t>(offset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
void TorqueGeneratedCoverageInfo<D, P>::set_slots_block_count(int i, int32_t value) {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 8 + i * 16;
  this->template WriteField<int32_t>(offset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
int32_t TorqueGeneratedCoverageInfo<D, P>::slots_padding(int i) const {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 12 + i * 16;
  int32_t value = this->template ReadField<int32_t>(offset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=71&c=3
template<class D, class P>
void TorqueGeneratedCoverageInfo<D, P>::set_slots_padding(int i, int32_t value) {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->slot_count());
  int offset = kSlotsOffset + 12 + i * 16;
  this->template WriteField<int32_t>(offset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=69&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedCoverageInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedCoverageInfo<D, P>::TorqueGeneratedCoverageInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsCoverageInfo_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=86&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedStackFrameInfo<D, P>::shared_or_script() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedStackFrameInfo::shared_or_script(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=86&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedStackFrameInfo<D, P>::shared_or_script(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kSharedOrScriptOffset);
  DCHECK(IsScript(value) || IsSharedFunctionInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=86&c=3
template<class D, class P>
void TorqueGeneratedStackFrameInfo<D, P>::set_shared_or_script(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsScript(value) || IsSharedFunctionInfo(value));
  WRITE_FIELD(*this, kSharedOrScriptOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kSharedOrScriptOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=87&c=3
template<class D, class P>
Tagged<String> TorqueGeneratedStackFrameInfo<D, P>::function_name() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedStackFrameInfo::function_name(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=87&c=3
template<class D, class P>
Tagged<String> TorqueGeneratedStackFrameInfo<D, P>::function_name(PtrComprCageBase cage_base) const {
  Tagged<String> value = TaggedField<Tagged<String>>::load(cage_base, *this, kFunctionNameOffset);
  DCHECK(IsString(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=87&c=3
template<class D, class P>
void TorqueGeneratedStackFrameInfo<D, P>::set_function_name(Tagged<String> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsString(value));
  WRITE_FIELD(*this, kFunctionNameOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kFunctionNameOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=88&c=3
template<class D, class P>
int TorqueGeneratedStackFrameInfo<D, P>::flags() const {
  int value = TaggedField<Smi>::load(*this, kFlagsOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=88&c=3
template<class D, class P>
void TorqueGeneratedStackFrameInfo<D, P>::set_flags(int value) {
  WRITE_FIELD(*this, kFlagsOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=79&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedStackFrameInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedStackFrameInfo<D, P>::TorqueGeneratedStackFrameInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsStackFrameInfo_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=124&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedErrorStackData<D, P>::call_site_infos_or_formatted_stack() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedErrorStackData::call_site_infos_or_formatted_stack(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=124&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedErrorStackData<D, P>::call_site_infos_or_formatted_stack(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kCallSiteInfosOrFormattedStackOffset);
  DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value) || IsFixedArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=124&c=3
template<class D, class P>
void TorqueGeneratedErrorStackData<D, P>::set_call_site_infos_or_formatted_stack(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value) || IsFixedArray(value));
  WRITE_FIELD(*this, kCallSiteInfosOrFormattedStackOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kCallSiteInfosOrFormattedStackOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=131&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedErrorStackData<D, P>::limit_or_stack_frame_infos() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedErrorStackData::limit_or_stack_frame_infos(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=131&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedErrorStackData<D, P>::limit_or_stack_frame_infos(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kLimitOrStackFrameInfosOffset);
  DCHECK(IsSmi(value) || IsFixedArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=131&c=3
template<class D, class P>
void TorqueGeneratedErrorStackData<D, P>::set_limit_or_stack_frame_infos(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsSmi(value) || IsFixedArray(value));
  WRITE_FIELD(*this, kLimitOrStackFrameInfosOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kLimitOrStackFrameInfosOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=120&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedErrorStackData<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedErrorStackData<D, P>::TorqueGeneratedErrorStackData(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsErrorStackData_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=135&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedPromiseOnStack<D, P>::prev() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedPromiseOnStack::prev(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=135&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedPromiseOnStack<D, P>::prev(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kPrevOffset);
  DCHECK(IsZero(value) || IsPromiseOnStack(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=135&c=3
template<class D, class P>
void TorqueGeneratedPromiseOnStack<D, P>::set_prev(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsZero(value) || IsPromiseOnStack(value));
  WRITE_FIELD(*this, kPrevOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPrevOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=136&c=3
template<class D, class P>
Tagged<MaybeObject> TorqueGeneratedPromiseOnStack<D, P>::promise() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedPromiseOnStack::promise(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=136&c=3
template<class D, class P>
Tagged<MaybeObject> TorqueGeneratedPromiseOnStack<D, P>::promise(PtrComprCageBase cage_base) const {
  Tagged<MaybeObject> value = TaggedField<Tagged<MaybeObject>>::load(cage_base, *this, kPromiseOffset);
  DCHECK(value.IsCleared() || (value.IsWeak() && IsJSObject(value.GetHeapObjectOrSmi())));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=136&c=3
template<class D, class P>
void TorqueGeneratedPromiseOnStack<D, P>::set_promise(Tagged<MaybeObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(value.IsCleared() || (value.IsWeak() && IsJSObject(value.GetHeapObjectOrSmi())));
  RELAXED_WRITE_WEAK_FIELD(*this, kPromiseOffset, value);
  CONDITIONAL_WEAK_WRITE_BARRIER(*this, kPromiseOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/debug-objects.tq?l=134&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedPromiseOnStack<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedPromiseOnStack<D, P>::TorqueGeneratedPromiseOnStack(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsPromiseOnStack_NonInline(*this));
}
