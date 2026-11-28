using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "push-compat", worker = (
    globalOutbound = "fake-provider",
    durableObjectNamespaces = [(className = "ChallengeReminders", uniqueKey = "30-days-disposable-runtime-test", enableSql = true)],
    durableObjectStorage = (inMemory = void),
    # Fixture values are generated for a local child process by run.mjs.
    bindings = [
      (name = "REMINDERS", durableObjectNamespace = "ChallengeReminders"),
      (name = "APP_ORIGIN", text = "https://shieldss.github.io"),
      (name = "PAIRING_KEY", fromEnvironment = "TEST_PAIRING_KEY"),
      (name = "VAPID_SUBJECT", text = "mailto:operator@example.com"),
      (name = "VAPID_PRIVATE_JWK", fromEnvironment = "TEST_VAPID_PRIVATE_JWK"),
      (name = "VAPID_PUBLIC_KEY", fromEnvironment = "TEST_VAPID_PUBLIC_KEY"),
    ],
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
