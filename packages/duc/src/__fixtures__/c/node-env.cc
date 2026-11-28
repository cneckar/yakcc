// SPDX-License-Identifier: Apache-2.0
// What Node's startup does for a binding's context (#1367), until env.cc's Environment is shaved:
// the context tagged as Node's (ContextEmbedderTag, node/src's own code) and given an Environment,
// of Environment's size, whose isolate is set, and its principal realm, whose context is this one
// (env->context(), as the bindings' argument parsing asks it): what Environment::GetCurrent and
// the bindings read. Nothing else of either is made; a binding that reads more traps.
// (The standard library's headers first, untouched; Environment's members opened to name its
// isolate's offset.)
#include <bits/stdc++.h>
#define private public
#define protected public
#include "env-inl.h"
#undef private
#undef protected

extern "C" void *yk_node_environment(v8::Isolate *isolate, v8::Local<v8::Context> *context) {
  alignas(node::Environment) static char storage[sizeof(node::Environment)];
  auto *env = reinterpret_cast<node::Environment *>(storage);
  // (A const member, set as its constructor would.)
  std::memcpy(storage + __builtin_offsetof(node::Environment, isolate_), &isolate, sizeof isolate);
  // (The realm's context, a v8::Global: the handle the Local holds, as PersistentToLocal reads
  // it back.)
  alignas(node::PrincipalRealm) static char realm[sizeof(node::PrincipalRealm)];
  static_assert(sizeof(v8::Global<v8::Context>) == sizeof(v8::Local<v8::Context>));
  std::memcpy(realm + __builtin_offsetof(node::Realm, context_), context, sizeof *context);
  auto *principal = reinterpret_cast<node::PrincipalRealm *>(realm);
  std::memcpy(storage + __builtin_offsetof(node::Environment, principal_realm_), &principal,
              sizeof principal);
  node::ContextEmbedderTag::TagNodeContext(*context);
  (*context)->SetAlignedPointerInEmbedderData(node::ContextEmbedderIndex::kEnvironment, env);
  return env;
}

// The per-isolate data a binding's per-isolate initializer reads (NODE_BINDING_PER_ISOLATE_INIT,
// its IsolateData*): of IsolateData's size, its isolate set, its templates empty, until env.cc's
// IsolateData is shaved.
extern "C" void *yk_node_isolate_data(v8::Isolate *isolate) {
  alignas(node::IsolateData) static char storage[sizeof(node::IsolateData)];
  std::memcpy(storage + __builtin_offsetof(node::IsolateData, isolate_), &isolate, sizeof isolate);
  return storage;
}

#if NODE_HAVE_I18N_SUPPORT
#include <unicode/udata.h>
// ICU's data, as Node's startup gives it (InitializeICUDirectory: the icudt it links in).
extern "C" int yk_node_icu_data(const void *data) {
  UErrorCode err = U_ZERO_ERROR;
  udata_setCommonData(data, &err);
  return static_cast<int>(err);
}
#endif

// The Environment's options, as its constructor takes them from the per-process options
// (node_options.cc's per_process::cli_options, built by its initializer), and bootstrapping done:
// what the options binding reads (getCLIOptionsValues).
#include "node_options.h"
extern "C" void yk_node_environment_options(void *environment) {
  auto *env = static_cast<node::Environment *>(environment);
  ::new (&env->options_) std::shared_ptr<node::EnvironmentOptions>(
      node::per_process::cli_options->per_isolate->per_env);
  env->principal_realm_->has_run_bootstrapping_code_ = true;
}
