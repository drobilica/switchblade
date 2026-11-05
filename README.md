# Switchblade

OpenCode server plugin that lets agents run indefinitely. When a provider hits a
rate / weekly / quota limit, Switchblade switches the session to the next model
in a committed ladder of currently free chat models and retries immediately.

## What it does

1. Listens on OpenCode's `retry` hook.
2. Detects limit errors — HTTP `429`, HTTP `402`, or a matching error message /
   type (`quota`, `weekly`, `rate limit`, `limit exceeded`, `insufficient`,
   `billing`, `over capacity`, case-insensitive).
3. On a match, calls `ctx.session.switchModel()` and sets
   `event.decision = { retry: true, delay: 0 }`.
4. On later turns, appends a short system note via the `context` hook.

The default ladder is committed at `src/free-fallbacks.json`. At plugin startup
Switchblade:

- loads the committed baseline,
- compares it against the currently available model catalog,
- removes committed models that are now disabled, unavailable, no longer chat
  models, missing tool support, or non-zero cost,
- uses the remaining models in baseline order.

If the catalog cannot be read, the committed baseline is used unvalidated. If
the baseline is missing or invalid, Switchblade falls back to its single built-in
default (`opencode/crouton-alpha-free`).

Per-session progress is tracked in memory and persisted via `ctx.storage`
(`sessions` key), so a restart resumes where it left off.

## Install

### A. Local copy in `.opencode/plugins/`

```bash
mkdir -p .opencode/plugins
cp -r switchblade .opencode/plugins/switchblade
cd .opencode/plugins/switchblade
npm install
```

OpenCode auto-loads plugins under `.opencode/plugins/`.

### B. Via `opencode.jsonc`

The config key is **`plugins`** (plural). The string form uses the defaults;
any `fallbacks` or `model` entry takes precedence:

```jsonc
{
  "plugins": ["opencode-plugin-switchblade"]
}
```

Object form with a custom chain:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-plugin-switchblade",
      "options": {
        "fallbacks": [
          { "providerID": "opencode", "id": "pulse-alpha-free" },
          { "providerID": "opencode", "id": "deepseek-v4.1-flash-free" }
        ]
      }
    }
  ]
}
```

## Config

| Option      | Type                              | Default                                  | Notes                                  |
| ----------- | --------------------------------- | ---------------------------------------- | -------------------------------------- |
| `fallbacks` | `[{ providerID?, id? }, ...]`     | committed `src/free-fallbacks.json`      | Chained fallbacks; takes precedence.    |
| `model`     | `{ providerID?, id? }`            | `opencode/crouton-alpha-free`            | Single fallback override.              |

- Omit `providerID` to default to `"opencode"`; omit `id` to default to
  `"crouton-alpha-free"`.
- `ctx.options` may be `undefined` or a string (e.g. `"latest"` in simple
  entries) — both are treated as “use the committed baseline”.
- Entries missing both `providerID` and `id` are ignored.

See `examples/opencode.jsonc`.

## Updating the free-model ladder

The baseline is generated from your authenticated local OpenCode catalog; it is
not invented or scraped:

```bash
npm run update:models
```

The script runs `opencode api get /api/model` and keeps models matching:

```text
type == "chat"
enabled       == true
status        == "active"
capabilities.tools == true
every cost tier == 0 (including cache)
```

It sorts by release date, then context, then provider/id, and writes
`src/free-fallbacks.json` atomically. Commit and push the result:

```bash
npm run update:models
git add src/free-fallbacks.json
git commit -m "Update free model fallback baseline"
git push
```

The plugin validates this baseline against the live catalog at each startup;
committed stale models are skipped. A remote CI job cannot refresh it because
it does not have access to your authenticated OpenCode server.

`update:models` never writes credentials, request headers, or organization IDs
to the JSON; tests reject common credential fields.

**Popularity is not exposed by OpenCode.** The ladder uses cost = 0, tool
support, availability, recency, and context. Add a manual trust tier to the
updater if you want stronger ordering.

## How it works

- **Retry hook** (`ctx.session.hook("retry", …)`): reads
  `event.error.status`, `event.error.message`, `event.sessionID`,
  `event.attempt`, `event.model`. On a limit error, switches to the next
  available fallback via `switchModel({ sessionID, model })`, then sets
  `event.decision = { retry: true, delay: 0 }`.
- **Already on the last fallback?** OpenCode's normal backoff is left alone.
- **Context hook** (`ctx.session.hook("context", …)`): pushes a `text` part to
  `event.system` for sessions that have switched.
- Helpers live in `src/helpers.ts`; tests cover them and the committed
  baseline.

## Caveats

- **Free fallback still needs free quota.** Chain exhaustion falls through to
  OpenCode's normal retry behavior.
- **Switch is session-wide.** `switchModel` changes the model for the whole
  session, not just one request.
- **One switch per limit error.** Each subsequent limit advances one step.
- **Switching is silent by default.** Users see the UI model change; the
  system note is not shown to users.
- **No quota forecasting.** This reacts to errors; it doesn’t reserve quota.

## Develop

```bash
npm install
npm run typecheck
npm test
npm run update:models
```

## Docs

OpenCode plugins: https://opencode.ai/v2/docs/build/plugins  
Server plugin API: https://opencode.ai/v2/docs/build/plugins/server
