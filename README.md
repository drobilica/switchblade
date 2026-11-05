# Switchblade

OpenCode server plugin that lets agents keep running when a model hits a quota,
rate, capacity, unavailable, or timeout condition. OpenCode classifies the
failure; Switchblade chooses the next available model from a committed ladder
and retries immediately.

## What it does

1. Listens on OpenCode's `retry` hook.
2. Classifies the provider failure:

   | Kind | Detection | Behavior |
   |---|---|---|
   | Limit / quota | `429`, `402`, or quota/rate-limit messages | Switch immediately |
   | Capacity / overload | `503`, `529`, or capacity/overloaded messages | Switch immediately |
   | Model unavailable | `404` with model in the error, disabled/hidden/not-in-region messages | Skip it and try another fallback |
   | Timeout | `408`, `504`, timeout/reset messages | Switch after `timeoutSwitchAfterAttempt` attempts (default `2`) |

3. Calls `ctx.session.switchModel()` and sets
   `event.decision = { retry: true, delay: 0 }` on success.
4. If a candidate is rejected by `switchModel()`, it is skipped; other candidates
   are tried without mutating `src/free-fallbacks.json`.
5. On later turns, a short system note is added via the `context` hook.

The default ladder is committed at `src/free-fallbacks.json`. At plugin startup
Switchblade:

- loads the committed baseline,
- compares it against the currently available model catalog,
- removes committed models that are disabled, unavailable, no longer chat models,
  missing tool support, region-restricted, or non-zero cost,
- uses the remaining models in baseline order.

If the catalog cannot be read, the committed baseline is used unvalidated. If
no committed model is currently available and you did not configure an explicit
`model`/`fallbacks` override, fallback switching is disabled instead of hiding
or forcing an unusable model.

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

The config key is **`plugins`** (plural). The string form uses the defaults:

```jsonc
{
  "plugins": ["opencode-plugin-switchblade"]
}
```

Object form with a custom chain or timeout threshold:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-plugin-switchblade",
      "options": {
        "timeoutSwitchAfterAttempt": 2,
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

| Option                    | Type                              | Default                                  | Notes |
| ------------------------- | --------------------------------- | ---------------------------------------- | ----- |
| `fallbacks`               | `[{ providerID?, id? }, ...]`     | committed `src/free-fallbacks.json`      | Chained fallbacks; takes precedence. |
| `model`                   | `{ providerID?, id? }`            | `opencode/crouton-alpha-free`            | Single fallback override. |
| `timeoutSwitchAfterAttempt` | `number`                        | `2`                                      | Minimum physical attempt before switching on timeout/reset. |

- Omit `providerID` to default to `"opencode"`; omit `id` to default to
  `"crouton-alpha-free"`.
- `ctx.options` may be `undefined` or a string (e.g. `"latest"` in simple
  entries) — both are treated as “use the committed baseline”.
- Entries missing both `providerID` and `id` are ignored.

See `examples/opencode.jsonc`.

## Updating the free-model ladder

The baseline is generated from your authenticated local OpenCode catalog:

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

The plugin validates the baseline against the live catalog at startup and also
skips candidates rejected at runtime. A remote CI job cannot refresh it because
it does not have access to your authenticated OpenCode server.

`update:models` never writes credentials, request headers, or organization IDs
to the JSON; tests reject common credential fields.

**Popularity is not exposed by OpenCode.** The ladder uses cost = 0, tool
support, availability, recency, and context. Add a manual trust tier to the
updater if you want stronger ordering.

## Provider timeouts

OpenCode itself controls transport timeouts. From Providers:

- 5 minutes for response headers,
- 15 minutes between streamed chunks,
- provider retry of a timed-out request up to three times,
- configurable through `headerTimeout`, `chunkTimeout`, and `timeout`.

Switchblade reacts when OpenCode surfaces the failure to the session retry
hook. Set provider timeouts where the provider is configured; do not hide data
resilience problems behind an infinite fallback ladder.

## Region / account restrictions

Some free models are not available in every region or on every sign-in.
Switchblade filters the committed pool against the local catalog where
possible, and also treats “unsupported region”/“not available” responses as
unavailable candidates to skip. If no fallback is selectable, switching is
disabled instead of selecting a hidden model.

## How it works

- **Retry hook** (`ctx.session.hook("retry", …)`): reads
  `event.error.status`, `event.error.message`, `event.error.type`,
  `event.sessionID`, `event.attempt`, `event.model`.
- **Unavailable candidate?** `switchModel()` is attempted for the next candidate;
  unavailable rejection is recorded in memory and skipped.
- **Already exhausted?** OpenCode’s normal retry backoff is left alone.
- **Context hook** (`ctx.session.hook("context", …)`): pushes a `text` part to
  `event.system` for sessions that have switched.
- Helpers live in `src/helpers.ts`; tests cover classification, chain building,
  candidate skipping, and the committed baseline.

## Caveats

- **Free fallback still needs free quota.** Availability and quota are not the
  same thing; a model can be listed but become temporarily over capacity.
- **Switch is session-wide.** `switchModel` changes the model for the whole
  session.
- **One switch per failure step.** Each new failure advances one model.
- **Timeout fallback is opt-in by attempt count.** Set
  `timeoutSwitchAfterAttempt: 1` if you want immediate timeout switching.
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
OpenCode models: https://opencode.ai/v2/docs/models  
OpenCode providers: https://opencode.ai/v2/docs/providers
