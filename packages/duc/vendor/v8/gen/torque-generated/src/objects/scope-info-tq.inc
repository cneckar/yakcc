class ScopeInfo;
// Alias for IsScopeInfo() that avoids inlining.
// https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=112&c=1
V8_EXPORT_PRIVATE bool IsScopeInfo_NonInline(Tagged<HeapObject> o);

// Definition https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=112&c=1
template <class D, class P>
class TorqueGeneratedScopeInfo : public P {
  static_assert(
      std::is_same<ScopeInfo, D>::value,
      "Use this class as direct base for ScopeInfo.");
  static_assert(
      std::is_same<HeapObject, P>::value,
      "Pass in HeapObject as second template parameter for TorqueGeneratedScopeInfo.");

 public: 
  using Super = P;
  using TorqueGeneratedClass = TorqueGeneratedScopeInfo<D,P>;

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=114&c=9
  inline int flags() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=114&c=9
  inline void set_flags(int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=117&c=3
  inline int parameter_count() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=117&c=3
  inline void set_parameter_count(int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=121&c=9
  inline int context_local_count() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=121&c=9
  inline void set_context_local_count(int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=126&c=9
  inline int module_variable_count() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=126&c=9
  inline void set_module_variable_count(int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=132&c=3
  inline Tagged<String> context_local_names(int i) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=132&c=3
  inline Tagged<String> context_local_names(PtrComprCageBase cage_base, int i) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=132&c=3
  inline void set_context_local_names(int i, Tagged<String> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=137&c=3
  inline Tagged<NameToIndexHashTable> context_local_names_hashtable() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=137&c=3
  inline Tagged<NameToIndexHashTable> context_local_names_hashtable(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=137&c=3
  inline void set_context_local_names_hashtable(Tagged<NameToIndexHashTable> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=143&c=3
  inline int context_local_infos(int i) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=143&c=3
  inline void set_context_local_infos(int i, int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=149&c=3
  inline int saved_class_variable_info() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=149&c=3
  inline void set_saved_class_variable_info(int value);

  // Torque type: (class String | Zero)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=155&c=3
  inline Tagged<Object> function_variable_info_name() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=155&c=3
  inline Tagged<Object> function_variable_info_name(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=155&c=3
  inline void set_function_variable_info_name(Tagged<Object> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=155&c=3
  inline int function_variable_info_context_or_stack_slot_index() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=155&c=3
  inline void set_function_variable_info_context_or_stack_slot_index(int value);

  // Torque type: (class String | class Undefined)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=160&c=3
  inline Tagged<PrimitiveHeapObject> inferred_function_name() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=160&c=3
  inline Tagged<PrimitiveHeapObject> inferred_function_name(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=160&c=3
  inline void set_inferred_function_name(Tagged<PrimitiveHeapObject> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=164&c=3
  inline int position_info_start() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=164&c=3
  inline void set_position_info_start(int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=164&c=3
  inline int position_info_end() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=164&c=3
  inline void set_position_info_end(int value);

  // Torque type: (TheHole | class ScopeInfo)
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=173&c=3
  inline Tagged<HeapObject> outer_scope_info() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=173&c=3
  inline Tagged<HeapObject> outer_scope_info(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=173&c=3
  inline void set_outer_scope_info(Tagged<HeapObject> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=178&c=3
  inline Tagged<FixedArray> locals_block_list() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=178&c=3
  inline Tagged<FixedArray> locals_block_list(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=178&c=3
  inline void set_locals_block_list(Tagged<FixedArray> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // Torque type: SourceTextModuleInfo
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=182&c=3
  inline Tagged<FixedArray> module_info() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=182&c=3
  inline Tagged<FixedArray> module_info(PtrComprCageBase cage_base) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=182&c=3
  inline void set_module_info(Tagged<FixedArray> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline Tagged<String> module_variables_name(int i) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline Tagged<String> module_variables_name(PtrComprCageBase cage_base, int i) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline void set_module_variables_name(int i, Tagged<String> value, WriteBarrierMode mode = UPDATE_WRITE_BARRIER);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline int module_variables_index(int i) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline void set_module_variables_index(int i, int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline int module_variables_properties(int i) const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline void set_module_variables_properties(int i, int value);

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=112&c=1
  V8_INLINE static Tagged<D> cast(Tagged<Object> object);
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=112&c=1
  V8_INLINE static Tagged<D> unchecked_cast(Tagged<Object> object) {
    return Tagged<D>::unchecked_cast(object);
  }

  DECL_PRINTER(ScopeInfo)

#ifdef VERIFY_HEAP
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=112&c=1
  V8_EXPORT_PRIVATE void ScopeInfoVerify(Isolate* isolate);
#endif  // VERIFY_HEAP

  static constexpr int kStartOfStrongFieldsOffset = P::kHeaderSize;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=114&c=9
  static constexpr int kFlagsOffset = P::kHeaderSize;
  static constexpr int kFlagsOffsetEnd = kFlagsOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=117&c=3
  static constexpr int kParameterCountOffset = kFlagsOffsetEnd + 1;
  static constexpr int kParameterCountOffsetEnd = kParameterCountOffset + kTaggedSize - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=121&c=9
  static constexpr int kContextLocalCountOffset = kParameterCountOffsetEnd + 1;
  static constexpr int kContextLocalCountOffsetEnd = kContextLocalCountOffset + kTaggedSize - 1;
  static constexpr int kHeaderSize = kContextLocalCountOffsetEnd + 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=126&c=9
  static constexpr int kModuleVariableCountOffset = kContextLocalCountOffsetEnd + 1;
  static constexpr int kModuleVariableCountOffsetEnd = kModuleVariableCountOffset + 0 - 1;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=132&c=3
  inline int ContextLocalNamesOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=137&c=3
  inline int ContextLocalNamesHashtableOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=143&c=3
  inline int ContextLocalInfosOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=149&c=3
  inline int SavedClassVariableInfoOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=155&c=3
  inline int FunctionVariableInfoOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=160&c=3
  inline int InferredFunctionNameOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=164&c=3
  inline int PositionInfoOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=173&c=3
  inline int OuterScopeInfoOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=178&c=3
  inline int LocalsBlockListOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=182&c=3
  inline int ModuleInfoOffset() const;
  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=184&c=3
  inline int ModuleVariablesOffset() const;
  static constexpr int kEndOfStrongFieldsOffset = kModuleVariableCountOffsetEnd + 1;
  static constexpr int kStartOfWeakFieldsOffset = kModuleVariableCountOffsetEnd + 1;
  static constexpr int kEndOfWeakFieldsOffset = kModuleVariableCountOffsetEnd + 1;

  // SizeFor implementations not generated due to complex array lengths

  // https://source.chromium.org/chromium/chromium/src/+/main:v8/src/objects/scope-info.tq?l=112&c=1
  inline int AllocatedSize() const;
  friend class Factory;

  template <class DAlias = D>
  constexpr TorqueGeneratedScopeInfo() : P() {
    static_assert(
        std::is_base_of<TorqueGeneratedScopeInfo, DAlias>::value,
        "class TorqueGeneratedScopeInfo should be used as direct base for ScopeInfo.");
  }

 protected:
  inline explicit constexpr TorqueGeneratedScopeInfo(Address ptr, typename P::SkipTypeCheckTag
)    : P(ptr, typename P::SkipTypeCheckTag{}) {}
  inline explicit TorqueGeneratedScopeInfo(Address ptr);
};

struct TorqueGeneratedPositionInfoOffsets {
  static constexpr int kStartOffset = 0;
  static constexpr int kEndOffset = 8;
  static constexpr int kSize = 16;
};

struct TorqueGeneratedFunctionVariableInfoOffsets {
  static constexpr int kNameOffset = 0;
  static constexpr int kContextOrStackSlotIndexOffset = 8;
  static constexpr int kSize = 16;
};

struct TorqueGeneratedModuleVariableOffsets {
  static constexpr int kNameOffset = 0;
  static constexpr int kIndexOffset = 8;
  static constexpr int kPropertiesOffset = 16;
  static constexpr int kSize = 24;
};

