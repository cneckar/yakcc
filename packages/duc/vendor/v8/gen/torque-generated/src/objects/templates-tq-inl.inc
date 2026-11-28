// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=7&c=3
template<class D, class P>
int TorqueGeneratedTemplateInfo<D, P>::serial_number() const {
  int value = TaggedField<Smi>::load(*this, kSerialNumberOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=7&c=3
template<class D, class P>
void TorqueGeneratedTemplateInfo<D, P>::set_serial_number(int value) {
  WRITE_FIELD(*this, kSerialNumberOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=8&c=3
template<class D, class P>
int TorqueGeneratedTemplateInfo<D, P>::number_of_properties() const {
  int value = TaggedField<Smi>::load(*this, kNumberOfPropertiesOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=8&c=3
template<class D, class P>
void TorqueGeneratedTemplateInfo<D, P>::set_number_of_properties(int value) {
  WRITE_FIELD(*this, kNumberOfPropertiesOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=9&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedTemplateInfo<D, P>::property_list() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedTemplateInfo::property_list(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=9&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedTemplateInfo<D, P>::property_list(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kPropertyListOffset);
  DCHECK(IsUndefined(value) || IsArrayList(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=9&c=3
template<class D, class P>
void TorqueGeneratedTemplateInfo<D, P>::set_property_list(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsArrayList(value));
  WRITE_FIELD(*this, kPropertyListOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPropertyListOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=10&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedTemplateInfo<D, P>::property_accessors() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedTemplateInfo::property_accessors(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=10&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedTemplateInfo<D, P>::property_accessors(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kPropertyAccessorsOffset);
  DCHECK(IsUndefined(value) || IsArrayList(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=10&c=3
template<class D, class P>
void TorqueGeneratedTemplateInfo<D, P>::set_property_accessors(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsArrayList(value));
  WRITE_FIELD(*this, kPropertyAccessorsOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPropertyAccessorsOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=5&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedTemplateInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedTemplateInfo<D, P>::TorqueGeneratedTemplateInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsTemplateInfo_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=15&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::prototype_template() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::prototype_template(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=15&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::prototype_template(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kPrototypeTemplateOffset);
  DCHECK(IsUndefined(value) || IsObjectTemplateInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=15&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_prototype_template(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsObjectTemplateInfo(value));
  WRITE_FIELD(*this, kPrototypeTemplateOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPrototypeTemplateOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=16&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::prototype_provider_template() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::prototype_provider_template(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=16&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::prototype_provider_template(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kPrototypeProviderTemplateOffset);
  DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=16&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_prototype_provider_template(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  WRITE_FIELD(*this, kPrototypeProviderTemplateOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPrototypeProviderTemplateOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=17&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::parent_template() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::parent_template(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=17&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::parent_template(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kParentTemplateOffset);
  DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=17&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_parent_template(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  WRITE_FIELD(*this, kParentTemplateOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kParentTemplateOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=18&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::named_property_handler() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::named_property_handler(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=18&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::named_property_handler(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kNamedPropertyHandlerOffset);
  DCHECK(IsUndefined(value) || IsInterceptorInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=18&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_named_property_handler(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsInterceptorInfo(value));
  WRITE_FIELD(*this, kNamedPropertyHandlerOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kNamedPropertyHandlerOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=19&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::indexed_property_handler() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::indexed_property_handler(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=19&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::indexed_property_handler(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kIndexedPropertyHandlerOffset);
  DCHECK(IsUndefined(value) || IsInterceptorInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=19&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_indexed_property_handler(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsInterceptorInfo(value));
  WRITE_FIELD(*this, kIndexedPropertyHandlerOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kIndexedPropertyHandlerOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=20&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::instance_template() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::instance_template(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=20&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::instance_template(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kInstanceTemplateOffset);
  DCHECK(IsUndefined(value) || IsObjectTemplateInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=20&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_instance_template(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsObjectTemplateInfo(value));
  WRITE_FIELD(*this, kInstanceTemplateOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kInstanceTemplateOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=21&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::instance_call_handler() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::instance_call_handler(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=21&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::instance_call_handler(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kInstanceCallHandlerOffset);
  DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=21&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_instance_call_handler(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  WRITE_FIELD(*this, kInstanceCallHandlerOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kInstanceCallHandlerOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=22&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::access_check_info() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::access_check_info(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=22&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateRareData<D, P>::access_check_info(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kAccessCheckInfoOffset);
  DCHECK(IsUndefined(value) || IsAccessCheckInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=22&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_access_check_info(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsAccessCheckInfo(value));
  WRITE_FIELD(*this, kAccessCheckInfoOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kAccessCheckInfoOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=23&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedFunctionTemplateRareData<D, P>::c_function_overloads() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateRareData::c_function_overloads(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=23&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedFunctionTemplateRareData<D, P>::c_function_overloads(PtrComprCageBase cage_base) const {
  Tagged<FixedArray> value = TaggedField<Tagged<FixedArray>>::load(cage_base, *this, kCFunctionOverloadsOffset);
  DCHECK(IsFixedArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=23&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateRareData<D, P>::set_c_function_overloads(Tagged<FixedArray> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsFixedArray(value));
  WRITE_FIELD(*this, kCFunctionOverloadsOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kCFunctionOverloadsOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=13&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedFunctionTemplateRareData<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedFunctionTemplateRareData<D, P>::TorqueGeneratedFunctionTemplateRareData(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsFunctionTemplateRareData_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=46&c=3
template<class D, class P>
Tagged<PrimitiveHeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::class_name() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateInfo::class_name(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=46&c=3
template<class D, class P>
Tagged<PrimitiveHeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::class_name(PtrComprCageBase cage_base) const {
  Tagged<PrimitiveHeapObject> value = TaggedField<Tagged<PrimitiveHeapObject>>::load(cage_base, *this, kClassNameOffset);
  DCHECK(IsString(value) || IsUndefined(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=46&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_class_name(Tagged<PrimitiveHeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsString(value) || IsUndefined(value));
  WRITE_FIELD(*this, kClassNameOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kClassNameOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=51&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::signature() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateInfo::signature(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=51&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::signature(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kSignatureOffset);
  DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=51&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_signature(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  WRITE_FIELD(*this, kSignatureOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kSignatureOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=57&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::rare_data(AcquireLoadTag) const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateInfo::rare_data(cage_base, kAcquireLoad);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=57&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::rare_data(PtrComprCageBase cage_base, AcquireLoadTag) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::Acquire_Load(cage_base, *this, kRareDataOffset);
  DCHECK(IsUndefined(value) || IsFunctionTemplateRareData(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=57&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_rare_data(Tagged<HeapObject> value, ReleaseStoreTag, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFunctionTemplateRareData(value));
  RELEASE_WRITE_FIELD(*this, kRareDataOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kRareDataOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=58&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::shared_function_info() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateInfo::shared_function_info(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=58&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedFunctionTemplateInfo<D, P>::shared_function_info(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kSharedFunctionInfoOffset);
  DCHECK(IsUndefined(value) || IsSharedFunctionInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=58&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_shared_function_info(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsSharedFunctionInfo(value));
  WRITE_FIELD(*this, kSharedFunctionInfoOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kSharedFunctionInfoOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=62&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedFunctionTemplateInfo<D, P>::cached_property_name() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateInfo::cached_property_name(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=62&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedFunctionTemplateInfo<D, P>::cached_property_name(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kCachedPropertyNameOffset);
  DCHECK(IsHeapObject(value) || IsSmi(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=62&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_cached_property_name(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsHeapObject(value) || IsSmi(value));
  WRITE_FIELD(*this, kCachedPropertyNameOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kCachedPropertyNameOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=69&c=36
template<class D, class P>
Tagged<Object> TorqueGeneratedFunctionTemplateInfo<D, P>::callback_data(AcquireLoadTag) const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedFunctionTemplateInfo::callback_data(cage_base, kAcquireLoad);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=69&c=36
template<class D, class P>
Tagged<Object> TorqueGeneratedFunctionTemplateInfo<D, P>::callback_data(PtrComprCageBase cage_base, AcquireLoadTag) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::Acquire_Load(cage_base, *this, kCallbackDataOffset);
  DCHECK(IsHeapObject(value) || IsSmi(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=69&c=36
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_callback_data(Tagged<Object> value, ReleaseStoreTag, WriteBarrierMode mode) {
  SLOW_DCHECK(IsHeapObject(value) || IsSmi(value));
  RELEASE_WRITE_FIELD(*this, kCallbackDataOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kCallbackDataOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=72&c=3
template<class D, class P>
uint32_t TorqueGeneratedFunctionTemplateInfo<D, P>::flag() const {
  uint32_t value = this->template ReadField<uint32_t>(kFlagOffset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=72&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_flag(uint32_t value) {
  this->template WriteField<uint32_t>(kFlagOffset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=74&c=3
template<class D, class P>
int16_t TorqueGeneratedFunctionTemplateInfo<D, P>::length() const {
  int16_t value = this->template ReadField<int16_t>(kLengthOffset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=74&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_length(int16_t value) {
  this->template WriteField<int16_t>(kLengthOffset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=77&c=3
template<class D, class P>
InstanceType TorqueGeneratedFunctionTemplateInfo<D, P>::instance_type() const {
  InstanceType value = this->template ReadField<InstanceType>(kInstanceTypeOffset);
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=77&c=3
template<class D, class P>
void TorqueGeneratedFunctionTemplateInfo<D, P>::set_instance_type(InstanceType value) {
  this->template WriteField<InstanceType>(kInstanceTypeOffset, value);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=44&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedFunctionTemplateInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedFunctionTemplateInfo<D, P>::TorqueGeneratedFunctionTemplateInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsFunctionTemplateInfo_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=94&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedObjectTemplateInfo<D, P>::constructor() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedObjectTemplateInfo::constructor(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=94&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedObjectTemplateInfo<D, P>::constructor(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kConstructorOffset);
  DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=94&c=3
template<class D, class P>
void TorqueGeneratedObjectTemplateInfo<D, P>::set_constructor(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFunctionTemplateInfo(value));
  WRITE_FIELD(*this, kConstructorOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kConstructorOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=95&c=3
template<class D, class P>
int TorqueGeneratedObjectTemplateInfo<D, P>::data() const {
  int value = TaggedField<Smi>::load(*this, kDataOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=95&c=3
template<class D, class P>
void TorqueGeneratedObjectTemplateInfo<D, P>::set_data(int value) {
  WRITE_FIELD(*this, kDataOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=92&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedObjectTemplateInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedObjectTemplateInfo<D, P>::TorqueGeneratedObjectTemplateInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsObjectTemplateInfo_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=100&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedDictionaryTemplateInfo<D, P>::property_names() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedDictionaryTemplateInfo::property_names(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=100&c=3
template<class D, class P>
Tagged<FixedArray> TorqueGeneratedDictionaryTemplateInfo<D, P>::property_names(PtrComprCageBase cage_base) const {
  Tagged<FixedArray> value = TaggedField<Tagged<FixedArray>>::load(cage_base, *this, kPropertyNamesOffset);
  DCHECK(IsFixedArray(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=100&c=3
template<class D, class P>
void TorqueGeneratedDictionaryTemplateInfo<D, P>::set_property_names(Tagged<FixedArray> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsFixedArray(value));
  WRITE_FIELD(*this, kPropertyNamesOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPropertyNamesOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=101&c=3
template<class D, class P>
int TorqueGeneratedDictionaryTemplateInfo<D, P>::serial_number() const {
  int value = TaggedField<Smi>::load(*this, kSerialNumberOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=101&c=3
template<class D, class P>
void TorqueGeneratedDictionaryTemplateInfo<D, P>::set_serial_number(int value) {
  WRITE_FIELD(*this, kSerialNumberOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/templates.tq?l=98&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedDictionaryTemplateInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedDictionaryTemplateInfo<D, P>::TorqueGeneratedDictionaryTemplateInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsDictionaryTemplateInfo_NonInline(*this));
}
