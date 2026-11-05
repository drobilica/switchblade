# Switchblade

OpenCode server plugin that lets agents run indefinitely. When a provider hits a
rate / weekly / quota limit, Switchblade switches the session to a configured
free fallback model and retries immediately.

## What it does

1. Listens on OpenCode's `retry` hook.
2. Detects limit errors — HTTP `429`, HTTP `402`, or a matching error message
   (`quota`, `weekly`, `rate limit`, `limit exceeded`, `insufficient`,
   `billing`, `over capacity`, case-insensitive, checked against both the
   error message and type).
3. On a match, calls `ctx.session.switchModel()` to move the session to the
   next model in its fallback chain (default: `opencode/crouton-alpha-free`).
4. Sets `decision = { retry: true, delay: 0 }` so OpenCode retries immediately.
5. On subsequent turns, appends a short system note via the `context` hook so
   the agent knows it switched (the note asks the agent not to mention it).

Per-session progress is tracked in memory and persisted via `ctx.storage`
(`sessions` key) so a restart resumes where it left off.

## Install

### A. Local copy in `.opencode/plugins/`

```bash
mkdir -p .opencode/plugins
cp -r switchblade .opencode/plugins/switchblade
# then in your repo: npm install --prefix .opencode/plugins/switchblade
# or cd into it and run: npm install
```

OpenCode auto-loads anything in `.opencode/plugins/`.

### B. Via `opencode.jsonc`

The config key is **`plugins`** (plural). Use the object form to pass options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-plugin-switchblade",
      "options": { "model": { "providerID": "opencode", "id": "crouton-alpha-free" } }
    }
  ]
}
```

Or omit `options` entirely for the defaults:

```jsonc
{
  "plugins": ["opencode-plugin-switchblade"]
}
```

## Config

| Option      | Type                | Default                                  | Notes                              |
| ----------- | ------------------- | ---------------------------------------- | ---------------------------------- |
| `model`     | `{ providerID?, id? }` | `{ providerID: "opencode", id: "crouton-alpha-free" }` | Single fallback.                    |
| `fallbacks` | `[{ providerID?, id? }, ...]` | — | Chained fallbacks; takes precedence over `model`. |

- Omit `providerID` to default to `"opencode"`; omit `id` to default to
  `"crouton-alpha-free"`.
- `ctx.options` may be `undefined` or a string (e.g. `"latest"` in simple
  entries) — both are treated as "use defaults".

See `examples/opencode.jsonc`.

## How it works

- **Retry hook** (`ctx.session.hook("retry", …)`): reads
  `event.error.status`, `event.error.message`, `event.sessionID`,
  `event.attempt`, `event.model`. On a limit error, switches to the next
  fallback via `switchModel({ sessionID, model })`, then sets
  `event.decision = { retry: true, delay: 0 }`.
- **Already on last fallback?** The hook returns without switching and leaves
  the retry decision to OpenCode's normal backoff.
- **Context hook** (`ctx.session.hook("context", …)`): pushes a `text` part to
  `event.system` for sessions that have switched.
- Helpers (`isLimitError`, `nextFallback`, `buildChain`) live in
  `src/helpers.ts` and are unit-tested in `tests/helpers.test.mjs`.

## Caveats

- **Free fallback still needs free quota.** If the fallback model is also
  rate-limited, the plugin simply runs out of chain and OpenCode's normal
  retry backoff takes over. Point `fallbacks` at providers you know are free.
- **Switch is session-wide.** `switchModel` changes the model for the whole
  session, not just one request.
- **One switch per limit error.** If a request fails again on the new model,
  the next `retry` event advances one more step down the chain.
- **Switching is silent by default.** Users see the model change in OpenCode's
  UI; the system note is hidden from the user ("do not mention this note").
  Logs go to stdout: `[switchblade] loaded, fallback chain: ...`.
- **No quota forecasting.** The plugin reacts to errors, it doesn't predict or
  reserve quota.

## Develop

```bash
npm install
npm run typecheck
npm test
```

## Docs

OpenCode plugins: https://opencode.ai/v2/docs/build/plugins
Server plugin API: https://opencode.ai/v2/docs/build/plugins/server
