using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "push-compat", worker = (
    globalOutbound = "fake-provider",
    compatibilityDate = "2026-11-01",
    modules = [
      (name = "push.mjs", esModule = embed "push.mjs"),
      (name = "worker.mjs", esModule = embed "../worker.mjs"),
    ],
  )), (name = "fake-provider", worker = (
    compatibilityDate = "2026-11-01",
    modules = [(name = "provider.mjs", esModule = embed "provider.mjs")],
  ))],
);
