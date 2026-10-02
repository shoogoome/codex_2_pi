# Cursor protocol core

Vendored from [Rahularya01/pi-cursor](https://github.com/Rahularya01/pi-cursor), version **1.4.38**, source commit `b8c11bc41de4bb4fc6a530f6e32724fbed2c81b2` (MIT; see `LICENSE`). The inspected checkout `7a2ab5e43911b173320bfe06b6ea0cd0ad7a6f76` differs only in upstream `vitest.config.ts`; the copied source is identical to the release source.

Only the transitive source dependencies of the native stream, model conversion/catalog, and OAuth client are included. The upstream extension factory, system-credential harvesting, CLI execution, usage commands, and direct `auth.json` mutation are **not** included. `proto/agent_pb.ts` is upstream's checked-in protobuf schema; `models/catalog.json` is fallback metadata, not evidence of account access.

## Local differences

- This package owns the native Pi `Provider` and cancellation-aware OAuth integration (`../provider.ts`). Pi owns credential persistence and refresh locking.
- `config/index.ts` accepts explicit official endpoint configuration only; it does not read Cursor CLI configuration. Request-local settings/headers/response instrumentation use `client/request-context.ts` without process-global environment mutation.
- `client/h2-session.ts` reports response headers before consuming the body and protects required authentication/protocol headers. `h2-proxy.ts` honors request-scoped proxy environment.
- `stream/native-core.ts` checks cancellation before setup, starts after credential resolution, and classifies setup cancellation as `aborted`. `stream-writer.ts` permits pre-start errors and redacts the request credential from error messages.
- `client/cursor-error.ts` decodes bounded `aiserver.v1.ErrorDetails` display fields (verified against the Cursor CLI schema), rather than losing limit/permission explanations behind a generic `Error`. Explicit non-retryable errors are not retried; final messages still pass through credential redaction.
- `stream/model-discovery.ts` supports explicit cache invalidation and does not print upstream failure bodies; the provider reports unavailable discovery without dropping the previous catalog. Provider activation synchronously restores the existing full raw model cache before Pi selects/restores a session model, preserving wire IDs, effort parameters and max-mode routing without startup network/auth refresh.
- `client/cursor-wire.ts` requests `AvailableModelsScope.USER_AVAILABLE` (field 10 = 1), verified against the official CLI schema and live metadata responses. Unspecified scope can omit Claude/GPT/Gemini. No admin/global scope is requested. `models/parameterized.ts` retains advertised empty parameter variants, including Gemini Pro and Flash.
- `stream/mcp-compat.ts` adds the current CLI's RequestContext inline dynamic MCP catalog (field 34), completeness (field 36), and MCP state request/result handling. `proto/mcp-state-compat.ts` privately clones the pinned descriptor to correctly decode exec field 36 (formerly planning, now MCP state), including repeated server identifiers. New context fields are preserved as unknown wire fields; shared/generated descriptors remain untouched. This advertises only Pi-owned tools and requires no actual MCP server.
- `stream/exec-native.ts` rejects native fetch. `server-messages.ts` disables automatic approval of hosted web/search; local file/shell tools remain rejected. Executable tools must go through Pi's MCP-shaped tool bridge.
- Pi's current tool declarations and full system prompt are always injected, regardless of greetings, acknowledgements, or identity questions. Upstream's conversational classifiers and prompt/tool omission branches are removed, not merely gated. Explicit tool choice and Pi's own tool removals remain authoritative.
- Tool schema slimming is off by default. Stream/lifecycle/debug output is opt-in, with private log writes.
- `stream/run-journal.ts` is memory-only. Pi remains the sole transcript persistence source; restart/branch/compaction recovery reconstructs protocol state from Pi history.
- `auth/oauth.ts` cancels polling timers and does not include server response bodies in refresh errors.

Upgrades require reviewing the upstream source diff and rerunning the local auth, policy, transport, and tool-loop tests. Do not silently replace this core with the upstream default factory.
