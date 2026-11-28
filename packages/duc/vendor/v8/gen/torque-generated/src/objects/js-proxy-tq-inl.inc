// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=6&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedJSProxy<D, P>::target() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSProxy::target(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=6&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedJSProxy<D, P>::target(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kTargetOffset);
  DCHECK(IsJSReceiver(value) || IsNull(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=6&c=3
template<class D, class P>
void TorqueGeneratedJSProxy<D, P>::set_target(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSReceiver(value) || IsNull(value));
  WRITE_FIELD(*this, kTargetOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kTargetOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=7&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedJSProxy<D, P>::handler() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSProxy::handler(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=7&c=3
template<class D, class P>
Tagged<HeapObject> TorqueGeneratedJSProxy<D, P>::handler(PtrComprCageBase cage_base) const {
  Tagged<HeapObject> value = TaggedField<Tagged<HeapObject>>::load(cage_base, *this, kHandlerOffset);
  DCHECK(IsJSReceiver(value) || IsNull(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=7&c=3
template<class D, class P>
void TorqueGeneratedJSProxy<D, P>::set_handler(Tagged<HeapObject> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSReceiver(value) || IsNull(value));
  WRITE_FIELD(*this, kHandlerOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kHandlerOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=5&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedJSProxy<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedJSProxy<D, P>::TorqueGeneratedJSProxy(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsJSProxy_NonInline(*this));
}
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=11&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedJSProxyRevocableResult<D, P>::proxy() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSProxyRevocableResult::proxy(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=11&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedJSProxyRevocableResult<D, P>::proxy(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kProxyOffset);
  DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=11&c=3
template<class D, class P>
void TorqueGeneratedJSProxyRevocableResult<D, P>::set_proxy(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value));
  WRITE_FIELD(*this, kProxyOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kProxyOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=12&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedJSProxyRevocableResult<D, P>::revoke() const {
  PtrComprCageBase cage_base = GetPtrComprCageBase(*this);
  return TorqueGeneratedJSProxyRevocableResult::revoke(cage_base);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=12&c=3
template<class D, class P>
Tagged<Object> TorqueGeneratedJSProxyRevocableResult<D, P>::revoke(PtrComprCageBase cage_base) const {
  Tagged<Object> value = TaggedField<Tagged<Object>>::load(cage_base, *this, kRevokeOffset);
  DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value));
  return value;
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=12&c=3
template<class D, class P>
void TorqueGeneratedJSProxyRevocableResult<D, P>::set_revoke(Tagged<Object> value, WriteBarrierMode mode) {
  SLOW_DCHECK(IsJSReceiver(value) || IsSmi(value) || IsHeapNumber(value) || IsBigInt(value) || IsString(value) || IsSymbol(value) || IsBoolean(value) || IsNull(value) || IsUndefined(value));
  WRITE_FIELD(*this, kRevokeOffset, value);
  CONDITIONAL_WRITE_BARRIER(*this, kRevokeOffset, value, mode);
}

// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/js-proxy.tq?l=10&c=1
template<class D, class P>
Tagged<D> TorqueGeneratedJSProxyRevocableResult<D, P>::cast(Tagged<Object> object) {
    return Tagged<D>(D(object.ptr()));
}

template<class D, class P>
inline TorqueGeneratedJSProxyRevocableResult<D, P>::TorqueGeneratedJSProxyRevocableResult(Address ptr)
    : P(ptr) {
  SLOW_DCHECK(IsJSObject_NonInline(*this));
}
