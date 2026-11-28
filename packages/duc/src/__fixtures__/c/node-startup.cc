// SPDX-License-Identifier: Apache-2.0
// Node's startup for one context, as src/node.cc and src/api/environment.cc do it (#1367): its
// IsolateData on libuv's default loop, with the per-process options' per-isolate ones; its
// Environment (Node's default flags, the main thread), and the main context initialized in it
// (InitializeMainContext: the principal realm, its properties from the per-context scripts'
// exports, which the runtime that runs Node's JavaScript gives the context first). Node's own
// constructors, shaved, in place of node-env.cc's fields written by hand.
#include "env-inl.h"
#include "node_options.h"
#include "node_realm-inl.h"
#include "uv.h"

extern "C" void *yk_node_start(v8::Isolate *isolate, v8::Local<v8::Context> *context) {
  auto *data = node::IsolateData::CreateIsolateData(isolate, uv_default_loop(), nullptr, nullptr,
                                                    nullptr,
                                                    node::per_process::cli_options->per_isolate);
  std::vector<std::string> args{"node"};
  std::vector<std::string> exec_args;
  auto *env = new node::Environment(data, isolate, args, exec_args, nullptr,
                                    node::EnvironmentFlags::kDefaultFlags, node::ThreadId{},
                                    "main");
  env->InitializeMainContext(*context, nullptr);
  return env;
}
