// SPDX-License-Identifier: Apache-2.0
// What Node's startup does for a binding's context (#1367), until env.cc's Environment is shaved:
// the context tagged as Node's (ContextEmbedderTag, node/src's own code) and given an Environment,
// of Environment's size, whose isolate is set: what Environment::GetCurrent and the bindings'
// initializers read. Nothing else of the Environment is made; a binding that reads more traps.
// (The standard library's headers first, untouched; Environment's members opened to name its
// isolate's offset.)
#include <bits/stdc++.h>
#define private public
#include "env-inl.h"
#undef private

extern "C" void *yk_node_environment(v8::Isolate *isolate, v8::Local<v8::Context> *context) {
  alignas(node::Environment) static char storage[sizeof(node::Environment)];
  auto *env = reinterpret_cast<node::Environment *>(storage);
  // (A const member, set as its constructor would.)
  std::memcpy(storage + __builtin_offsetof(node::Environment, isolate_), &isolate, sizeof isolate);
  node::ContextEmbedderTag::TagNodeContext(*context);
  (*context)->SetAlignedPointerInEmbedderData(node::ContextEmbedderIndex::kEnvironment, env);
  return env;
}
