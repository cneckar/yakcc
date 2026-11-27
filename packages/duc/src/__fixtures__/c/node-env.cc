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
