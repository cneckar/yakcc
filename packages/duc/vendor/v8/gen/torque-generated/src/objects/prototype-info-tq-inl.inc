// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=14&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedPrototypeInfo<D, P>::module_namespace() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedPrototypeInfo::module_namespace(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=14&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedPrototypeInfo<D, P>::module_namespace(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kModuleNamespaceOffset);
  DCHECK(IsUndefined(value) || IsJSModuleNamespace(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=14&c=3
template<class D, class P>
void TorqueGeneratedPrototypeInfo<D, P>::set_module_namespace(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsJSModuleNamespace(value));
  WRITE_FIELD(*this, kModuleNamespaceOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kModuleNamespaceOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=18&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedPrototypeInfo<D, P>::prototype_users() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedPrototypeInfo::prototype_users(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=18&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedPrototypeInfo<D, P>::prototype_users(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kPrototypeUsersOffset);
  DCHECK(IsZero(value) || IsWeakArrayList(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=18&c=3
template<class D, class P>
void TorqueGeneratedPrototypeInfo<D, P>::set_prototype_users(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsZero(value) || IsWeakArrayList(value));
  WRITE_FIELD(*this, kPrototypeUsersOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPrototypeUsersOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=20&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedPrototypeInfo<D, P>::prototype_chain_enum_cache() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedPrototypeInfo::prototype_chain_enum_cache(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=20&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedPrototypeInfo<D, P>::prototype_chain_enum_cache(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kPrototypeChainEnumCacheOffset);
  DCHECK(IsUndefined(value) || IsFixedArray(value) || IsZero(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=20&c=3
template<class D, class P>
void TorqueGeneratedPrototypeInfo<D, P>::set_prototype_chain_enum_cache(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsFixedArray(value) || IsZero(value));
  WRITE_FIELD(*this, kPrototypeChainEnumCacheOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kPrototypeChainEnumCacheOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=24&c=3
template<class D, class P>
int TorqueGeneratedPrototypeInfo<D, P>::registry_slot() const {
  int value = TaggedField<Smi>::load(*this, kRegistrySlotOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=24&c=3
template<class D, class P>
void TorqueGeneratedPrototypeInfo<D, P>::set_registry_slot(int value) {
  WRITE_FIELD(*this, kRegistrySlotOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=26&c=3
template<class D, class P>
int TorqueGeneratedPrototypeInfo<D, P>::bit_field() const {
  int value = TaggedField<Smi>::load(*this, kBitFieldOffset).value();
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=26&c=3
template<class D, class P>
void TorqueGeneratedPrototypeInfo<D, P>::set_bit_field(int value) {
  WRITE_FIELD(*this, kBitFieldOffset, Smi::FromInt(value));
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=31&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedPrototypeInfo<D, P>::derived_maps() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedPrototypeInfo::derived_maps(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=31&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedPrototypeInfo<D, P>::derived_maps(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kDerivedMapsOffset);
  DCHECK(IsUndefined(value) || IsWeakArrayList(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=31&c=3
template<class D, class P>
void TorqueGeneratedPrototypeInfo<D, P>::set_derived_maps(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsUndefined(value) || IsWeakArrayList(value));
  WRITE_FIELD(*this, kDerivedMapsOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kDerivedMapsOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/prototype-info.tq?l=9&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedPrototypeInfo<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedPrototypeInfo<D, P>::TorqueGeneratedPrototypeInfo(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsPrototypeInfo_NonInline(*this));
}
