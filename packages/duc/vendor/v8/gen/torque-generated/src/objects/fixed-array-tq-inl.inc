// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=14&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceFixedArrayObjects(Tagged<FixedArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=39&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceWeakFixedArrayObjects(Tagged<WeakFixedArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceWeakArrayListObjects(Tagged<WeakArrayList> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=33&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceFixedDoubleArrayFloats(Tagged<FixedDoubleArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=22&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceTrustedFixedArrayObjects(Tagged<TrustedFixedArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=28&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceProtectedFixedArrayObjects(Tagged<ProtectedFixedArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=44&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceByteArrayBytes(Tagged<ByteArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=50&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceTrustedByteArrayBytes(Tagged<TrustedByteArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=55&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceExternalPointerArrayPointers(Tagged<ExternalPointerArray> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=64&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceArrayListObjects(Tagged<ArrayList> p_o);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=73&c=1
inline intptr_t TqRuntimeFromConstexpr_intptr_constexpr_int31_0(int31_t p_i);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=290&c=1
inline intptr_t TqRuntimeConvert_intptr_Smi_0(Tagged<Smi> p_s);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=8&c=1
inline intptr_t TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral p_i);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/contexts.tq?l=14&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_Object_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=39&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_MaybeObject_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=33&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_float64_or_hole_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=28&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_Smi_OR_TrustedObject_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/bytecode-array.tq?l=19&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_uint8_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=55&c=3
inline std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_ExternalPointer_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length);

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=79&c=1
inline intptr_t TqRuntimeFromConstexpr_intptr_constexpr_intptr_0(intptr_t p_i);

#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceFixedArrayObjects
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceFixedArrayObjects

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=14&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceFixedArrayObjects(Tagged<FixedArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_Object_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceFixedArrayObjects
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceWeakFixedArrayObjects
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceWeakFixedArrayObjects

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=39&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceWeakFixedArrayObjects(Tagged<WeakFixedArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_MaybeObject_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceWeakFixedArrayObjects
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceWeakArrayListObjects
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceWeakArrayListObjects

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceWeakArrayListObjects(Tagged<WeakArrayList> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x18ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_MaybeObject_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceWeakArrayListObjects
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceFixedDoubleArrayFloats
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceFixedDoubleArrayFloats

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=33&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceFixedDoubleArrayFloats(Tagged<FixedDoubleArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_float64_or_hole_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceFixedDoubleArrayFloats
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceTrustedFixedArrayObjects
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceTrustedFixedArrayObjects

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=22&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceTrustedFixedArrayObjects(Tagged<TrustedFixedArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_Object_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceTrustedFixedArrayObjects
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceProtectedFixedArrayObjects
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceProtectedFixedArrayObjects

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=28&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceProtectedFixedArrayObjects(Tagged<ProtectedFixedArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_Smi_OR_TrustedObject_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceProtectedFixedArrayObjects
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceByteArrayBytes
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceByteArrayBytes

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=44&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceByteArrayBytes(Tagged<ByteArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_uint8_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceByteArrayBytes
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceTrustedByteArrayBytes
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceTrustedByteArrayBytes

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=50&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceTrustedByteArrayBytes(Tagged<TrustedByteArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_uint8_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceTrustedByteArrayBytes
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceExternalPointerArrayPointers
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceExternalPointerArrayPointers

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=55&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceExternalPointerArrayPointers(Tagged<ExternalPointerArray> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x10ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_ExternalPointer_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceExternalPointerArrayPointers
#ifndef V8_INTERNAL_DEFINED_TqRuntimeFieldSliceArrayListObjects
#define V8_INTERNAL_DEFINED_TqRuntimeFieldSliceArrayListObjects

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=64&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeFieldSliceArrayListObjects(Tagged<ArrayList> p_o) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  Tagged<Smi> tmp1{}; USE(tmp1);
  intptr_t tmp2{}; USE(tmp2);
  intptr_t tmp3{}; USE(tmp3);
  Tagged<Object> tmp4{}; USE(tmp4);
  intptr_t tmp5{}; USE(tmp5);
  intptr_t tmp6{}; USE(tmp6);
  goto block0;

  block0:
  tmp0 = TqRuntimeFromConstexpr_intptr_constexpr_int31_0(8);
  tmp1 = TaggedField<Tagged<Smi>>::load(Tagged<HeapObject>::unchecked_cast(p_o), static_cast<int>(tmp0));
  tmp2 = TqRuntimeConvert_intptr_Smi_0(tmp1);
  tmp3 = TqRuntimeFromConstexpr_intptr_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x18ull));
  std::tie(tmp4, tmp5, tmp6) = TqRuntimeNewMutableSlice_Object_0(p_o, tmp3, tmp2);
  goto block2;

  block2:
  return std::make_tuple(tmp4, tmp5, tmp6);
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeFieldSliceArrayListObjects
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
#ifndef V8_INTERNAL_DEFINED_TqRuntimeConvert_intptr_Smi_0
#define V8_INTERNAL_DEFINED_TqRuntimeConvert_intptr_Smi_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/builtins/convert.tq?l=290&c=1
intptr_t TqRuntimeConvert_intptr_Smi_0(Tagged<Smi> p_s) {
  DisallowGarbageCollection no_gc;
  intptr_t tmp0{}; USE(tmp0);
  goto block0;

  block0:
  tmp0 = TorqueRuntimeMacroShims::CodeStubAssembler::SmiUntag(p_s);
  goto block2;

  block2:
  return tmp0;
}

#endif // V8_INTERNAL_DEFINED_TqRuntimeConvert_intptr_Smi_0
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
#ifndef V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_Object_0
#define V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_Object_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/contexts.tq?l=14&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_Object_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length) {
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

#endif // V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_Object_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_MaybeObject_0
#define V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_MaybeObject_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=39&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_MaybeObject_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length) {
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

#endif // V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_MaybeObject_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_float64_or_hole_0
#define V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_float64_or_hole_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=33&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_float64_or_hole_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length) {
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

#endif // V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_float64_or_hole_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_Smi_OR_TrustedObject_0
#define V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_Smi_OR_TrustedObject_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=28&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_Smi_OR_TrustedObject_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length) {
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

#endif // V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_Smi_OR_TrustedObject_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_uint8_0
#define V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_uint8_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/bytecode-array.tq?l=19&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_uint8_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length) {
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

#endif // V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_uint8_0
#ifndef V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_ExternalPointer_0
#define V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_ExternalPointer_0

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=55&c=3
std::tuple<Tagged<Object>, intptr_t, intptr_t> TqRuntimeNewMutableSlice_ExternalPointer_0(Tagged<Object> p_object, intptr_t p_offset, intptr_t p_length) {
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

#endif // V8_INTERNAL_DEFINED_TqRuntimeNewMutableSlice_ExternalPointer_0
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
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=69&c=9
template<class D, class P>
int TorqueGeneratedWeakArrayList<D, P>::capacity() const {
  int value = TaggedField<Smi>::load(*this, kCapacityOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=69&c=9
template<class D, class P>
void TorqueGeneratedWeakArrayList<D, P>::set_capacity(int value) {
  WRITE_FIELD(*this, kCapacityOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=70&c=3
template<class D, class P>
int TorqueGeneratedWeakArrayList<D, P>::length() const {
  int value = TaggedField<Smi>::load(*this, kLengthOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=70&c=3
template<class D, class P>
void TorqueGeneratedWeakArrayList<D, P>::set_length(int value) {
  WRITE_FIELD(*this, kLengthOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
template<class D, class P>
Tagged<MaybeObject> TorqueGeneratedWeakArrayList<D, P>::objects(int i, RelaxedLoadTag) const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedWeakArrayList::objects(cage_base, i, kRelaxedLoad);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
template<class D, class P>
Tagged<MaybeObject> TorqueGeneratedWeakArrayList<D, P>::objects(PtrComprCageBase cage_base, int i, RelaxedLoadTag) const {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->capacity());
  int offset = kObjectsOffset + i * kTaggedSize;
  Tagged<MaybeObject> value = TaggedField<Tagged<MaybeObject>>::Relaxed_Load(cage_base, *this, offset);
  DCHECK(value.IsCleared() || (!value.IsWeak() && IsHeapObject(value.GetHeapObjectOrSmi())) || (!value.IsWeak() && IsSmi(value.GetHeapObjectOrSmi())) || value.IsWeak());
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=71&c=19
template<class D, class P>
void TorqueGeneratedWeakArrayList<D, P>::set_objects(int i, Tagged<MaybeObject> value, WriteBarrierMode mode) {
  DCHECK_GE(i, 0);
  DCHECK_LT(i, this ->capacity());
  int offset = kObjectsOffset + i * kTaggedSize;
  SLOW_DCHECK(value.IsCleared() || (!value.IsWeak() && IsHeapObject(value.GetHeapObjectOrSmi())) || (!value.IsWeak() && IsSmi(value.GetHeapObjectOrSmi())) || value.IsWeak());
  RELAXED_WRITE_WEAK_FIELD(*this, offset, value);
  CONDITIONAL_WEAK_WRITE_BARRIER(*this, offset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/fixed-array.tq?l=67&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedWeakArrayList<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedWeakArrayList<D, P>::TorqueGeneratedWeakArrayList(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsWeakArrayList_NonInline(*this));
}
