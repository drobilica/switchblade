// Switchblade — OpenCode server plugin for provider failure fallback.
//
// On quota/rate limits (429/402), capacity/overload failures (503/529), or
// model-unavailable errors, Switchblade switches the session to the next model
// in the fallback ladder and sets decision.retry so the request retries.
// Timeouts are also eligible after the configured attempt.
//
// Default ladder: src/free-fallbacks.json, generated from the local model
// catalog with `npm run update:models` and validated at load time. A session
// only walks the committed free models, minus any now disabled/unavailable.
// If the ladder is exhausted, a session may retry again after exhaustedResetMs
// (default: 1 hour). If the user selects a model after exhaustion, the plugin
// can inject a synthetic "continue" message (default: enabled).
//
// Configuration (object form of `plugins` in opencode.jsonc):
//   model:     { providerID?, id? }  — single fallback override
//   fallbacks: [ { providerID?, id? }, ... ] — chained fallback override
//   timeoutSwitchAfterAttempt: 2      — switch on timeout after N physical attempts
//   exhaustedResetMs: 3600000        — retry from the top after ladder exhaustion
//   autoResume: true                  — synthetic "continue" after model selection
// Explicit options take precedence over the committed baseline.

import { readFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin";
import {
  fallbackErrorKind,
  hasExplicitFallbackOptions,
  isUnavailableSwitchFailure,
  nextAvailableFallback,
  buildChain,
  sanitizeBaseline,
  timeoutSwitchAfterAttempt,
  exhaustedResetMs,
  autoResumeEnabled,
  type SwitchbladeModel,
} from "./helpers.ts";

const STORAGE_KEY = "sessions";

type SwitchMap = Map<string, number>;
type ExhaustionMap = Map<string, number>;

type SwitchState = {
  indices: SwitchMap;
  exhausted: ExhaustionMap;
};

const emptyState = (): SwitchState => ({
  indices: new Map<string, number>(),
  exhausted: new Map<string, number>(),
});

/** Read the committed free-model baseline; returns [] when unavailable/invalid. */
function loadBaseline(): SwitchbladeModel[] {
  try {
    const raw = readFileSync(
      new URL("./free-fallbacks.json", import.meta.url),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { fallbacks?: unknown };
    return sanitizeBaseline(parsed?.fallbacks);
  } catch (err) {
    console.warn(
      `[switchblade] free-fallbacks.json unavailable/invalid: ${
        (err as Error)?.message ?? err
      }`
    );
    return [];
  }
}

const modelKey = (model: SwitchbladeModel): string =>
  `${model.providerID}/${model.id}`;

function isZeroCost(tier: any): boolean {
  const zero = (number: unknown): boolean =>
    number == null || (typeof number === "number" && number === 0);
  return (
    zero(tier?.input) &&
    zero(tier?.output) &&
    zero(tier?.cache?.read) &&
    zero(tier?.cache?.write)
  );
}

/** Return the set of currently selectable zero-cost chat models, or null if the catalog can't be read. */
async function availableModelKeys(ctx: any): Promise<Set<string> | null> {
  try {
    const models = await ctx.model?.list?.();
    if (!Array.isArray(models)) return null;

    const keys = new Set<string>();
    for (const model of models) {
      if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") continue;
      if (model.enabled === false) continue;
      if (typeof model.status === "string" && model.status !== "active") continue;
      if (typeof model.type === "string" && model.type !== "chat") continue;
      if (model.capabilities && model.capabilities.tools !== true) continue;
      if (Array.isArray(model.cost) && model.cost.length > 0 && !model.cost.every(isZeroCost)) continue;
      keys.add(`${model.providerID}/${model.id}`);
    }
    return keys;
  } catch {
    // Catalog unavailable: keep the committed baseline as-is.
    return null;
  }
}

/** Return the set of currently selectable models (any cost), or null if the catalog can't be read. */
async function selectableModelKeys(ctx: any): Promise<Set<string> | null> {
  try {
    const models = await ctx.model?.list?.();
    if (!Array.isArray(models)) return null;

    const keys = new Set<string>();
    for (const model of models) {
      if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") continue;
      if (model.enabled === false) continue;
      if (typeof model.status === "string" && model.status !== "active") continue;
      keys.add(`${model.providerID}/${model.id}`);
    }
    return keys;
  } catch {
    return null;
  }
}

/** Warn when configured agents reference models no longer in the project catalog. */
async function warnUnavailableConfiguredAgents(ctx: any): Promise<void> {
  const catalog = await selectableModelKeys(ctx);
  if (!catalog) {
    console.warn("[switchblade] unable to audit configured models: model list unavailable");
    return;
  }

  const keyFromRef = (model: any): string | null =>
    model && typeof model.providerID === "string" && typeof model.id === "string"
      ? `${model.providerID}/${model.id}`
      : null;

  try {
    const selected = await ctx.model?.default?.();
    const rootModel = (selected as any)?.model ?? selected;
    const rootKey = keyFromRef(rootModel);
    if (rootKey && !catalog.has(rootKey)) {
      console.warn(
        `[switchblade] UNAVAILABLE MODEL configured as root default: ${rootKey} (not selectable in this project/account/region)`
      );
    }
  } catch {
    // Root default audit is best-effort.
  }

  try {
    const agents = await ctx.agent?.list?.();
    if (!Array.isArray(agents)) return;

    for (const agent of agents) {
      const model = (agent as any)?.model;
      if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") continue;
      const key = `${model.providerID}/${model.id}`;
      if (!catalog.has(key)) {
        console.warn(
          `[switchblade] UNAVAILABLE MODEL configured for agent ${(agent as any).id ?? "<unknown>"}: ${key} (not selectable in this project/account/region)`
        );
      }
    }
  } catch (err) {
    console.warn(
      `[switchblade] unable to audit configured agent models: ${(err as Error)?.message ?? err}`
    );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const finiteNumberMap = (value: unknown): SwitchMap => {
  const map: SwitchMap = new Map();
  if (!isRecord(value)) return map;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) map.set(key, v);
  }
  return map;
};

async function loadPersisted(ctx: any): Promise<SwitchState> {
  const state = emptyState();
  try {
    const raw = await ctx.storage?.get?.(STORAGE_KEY);
    const parsed =
      typeof raw === "string" ? JSON.parse(raw) : (raw as unknown);
    if (!isRecord(parsed)) return state;

    // New format: { sessions: {...}, exhausted: {...} }.
    if (isRecord(parsed.sessions) || isRecord(parsed.exhausted)) {
      state.indices = finiteNumberMap(parsed.sessions);
      state.exhausted = finiteNumberMap(parsed.exhausted);
      return state;
    }

    // Backward compatibility: the old format was a flat session->index map.
    state.indices = finiteNumberMap(parsed);
  } catch {
    // Corrupt / unreadable storage: start fresh, don't crash the plugin.
  }
  return state;
}

async function persist(ctx: any, state: SwitchState): Promise<void> {
  try {
    await ctx.storage?.set?.(STORAGE_KEY, {
      sessions: Object.fromEntries(state.indices),
      exhausted: Object.fromEntries(state.exhausted),
    });
  } catch {
    // Best-effort only; in-memory state is the fallback.
  }
}

export default Plugin.define({
  id: "switchblade",

  async setup(ctx) {
    const options = (ctx as any).options;
    const explicitChain = hasExplicitFallbackOptions(options);
    const timeoutAfter = timeoutSwitchAfterAttempt(options);
    const resetAfterMs = exhaustedResetMs(options);
    const autoResume = autoResumeEnabled(options);

    const committed = loadBaseline();
    const available = await availableModelKeys(ctx);
    const baseline = available
      ? committed.filter((model) => available.has(modelKey(model)))
      : committed;

    if (available) {
      console.log(
        `[switchblade] committed baseline: ${committed.length}; available now: ${baseline.length}`
      );
    } else {
      console.warn("[switchblade] model list unavailable; using committed baseline unvalidated");
    }

    await warnUnavailableConfiguredAgents(ctx);

    const disabled = !explicitChain && available !== null && baseline.length === 0;
    if (disabled) {
      console.warn(
        "[switchblade] no free fallback models are currently selectable (check OPENCODE_DISABLE_FREE_MODELS, account sign-in, or region); fallback switching disabled"
      );
    }

    const chain: SwitchbladeModel[] = disabled ? [] : buildChain(options, baseline);

    // Models rejected by switchModel() during this plugin instance. These are
    // skipped by future attempts without rewriting the committed baseline.
    const unavailableKeys = new Set<string>();

    // Automatic selections are tracked (with a short TTL) so the model.selected
    // subscriber does not inject a synthetic resume for this plugin's own
    // switchModel() calls.
    const expectedSelections = new Map<string, number>();
    const pruneExpectedSelections = (): void => {
      const now = Date.now();
      for (const [key, created] of expectedSelections) {
        if (now - created > 30_000) expectedSelections.delete(key);
      }
    };

    // Per-session fallback position and exhaustion timestamps.
    const state: SwitchState = await loadPersisted(ctx);

    // Clamp indices persisted by an older/larger baseline.
    for (const [sessionID, index] of state.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= chain.length) {
        state.indices.delete(sessionID);
      }
    }

    console.log(
      `[switchblade] loaded, fallback chain: ${
        chain.length
          ? chain.map((m) => `${m.providerID}/${m.id}`).join(" -> ")
          : "<disabled>"
      }`
    );
    console.log(
      `[switchblade] exhausted reset: ${resetAfterMs}ms; autoResume: ${autoResume}`
    );

    // Retry hook: switch to the next usable fallback when OpenCode reports a
    // quota/rate/capacity/unavailable/timeout condition.
    const retryReg = await ctx.session.hook("retry", async (event: any) => {
      const kind = fallbackErrorKind(event, timeoutAfter);
      if (!kind || chain.length === 0) return;

      const sessionID: string = event.sessionID;
      const now = Date.now();
      const blocked = new Set(unavailableKeys);

      let effectiveIndex = state.indices.get(sessionID) ?? -1;
      const exhaustedAt = state.exhausted.get(sessionID);
      if (exhaustedAt) {
        if (now - exhaustedAt >= resetAfterMs) {
          state.indices.delete(sessionID);
          effectiveIndex = -1;
          console.log(
            `[switchblade] session ${sessionID}: ${resetAfterMs}ms elapsed; retrying ladder from the top`
          );
        } else {
          const remainingMs = resetAfterMs - (now - exhaustedAt);
          console.log(
            `[switchblade] session ${sessionID}: ladder exhausted; earliest retry from the top in ${Math.ceil(remainingMs / 60000)} minute(s)`
          );
          return;
        }
      }

      let candidate = nextAvailableFallback(chain, event.model, effectiveIndex, blocked);
      while (candidate) {
        const expectKey = `${sessionID}:${modelKey(candidate.model)}`;
        expectedSelections.set(expectKey, Date.now());
        pruneExpectedSelections();
        try {
          await ctx.session.switchModel({
            sessionID,
            model: candidate.model,
          });
        } catch (err) {
          expectedSelections.delete(expectKey);
          const key = modelKey(candidate.model);
          blocked.add(key);
          if (isUnavailableSwitchFailure(err)) unavailableKeys.add(key);
          console.warn(
            `[switchblade] session ${sessionID}: fallback candidate ${key} rejected (${isUnavailableSwitchFailure(err) ? "unavailable" : "unknown failure"}); trying next candidate`
          );
          effectiveIndex = candidate.index;
          candidate = nextAvailableFallback(
            chain,
            event.model,
            effectiveIndex,
            blocked
          );
          continue;
        }

        state.indices.set(sessionID, candidate.index);
        state.exhausted.delete(sessionID);
        await persist(ctx, state);
        console.log(
          `[switchblade] session ${sessionID}: ${kind} failure, switched to ${modelKey(candidate.model)} (attempt ${event.attempt}), retrying immediately`
        );
        event.decision = { retry: true, delay: 0 };
        return;
      }

      state.exhausted.set(sessionID, now);
      await persist(ctx, state);
      console.warn(
        `[switchblade] session ${sessionID}: no switchable fallback remains for ${kind} failure; earliest retry from the top in ${Math.ceil(resetAfterMs / 60000)} minute(s)`
      );
    });

    // Context hook: remind the agent when this session switched or is exhausted.
    const contextReg = await ctx.session.hook("context", (event: any) => {
      const index = state.indices.get(event.sessionID);
      const current = index != null && index >= 0 ? chain[index] : undefined;
      if (current) {
        event.system.push({
          type: "text",
          text: `[switchblade] This session was moved to ${current.providerID}/${current.id} after the previous model hit an availability, capacity, quota, or timeout limit. Continue your work normally; do not mention this note to the user.`,
        });
        return;
      }

      if (state.exhausted.has(event.sessionID)) {
        event.system.push({
          type: "text",
          text: "[switchblade] All configured fallback models failed or were unavailable. Continue with the current request if possible; otherwise explain that a model selection or retry is required. Do not mention this note to the user.",
        });
      }
    });

    // Resume an exhausted session only when a model is explicitly selected.
    // Automatic switchModel() calls are tracked in expectedSelections and do
    // not inject a second synthetic resume.
    const modelSelectedAbort = new AbortController();
    const eventModelKey = (model: any): string | null =>
      model && typeof model.providerID === "string" && typeof model.id === "string"
        ? `${model.providerID}/${model.id}`
        : null;

    if (ctx.event?.subscribe) {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            types: ["session.model.selected"],
            signal: modelSelectedAbort.signal,
          })) {
            const selectedEvent = event as any;
            if (selectedEvent?.type !== "session.model.selected") continue;

            const sessionID = selectedEvent.sessionID;
            const selectedKey = eventModelKey(selectedEvent.model);
            if (!sessionID || !selectedKey) continue;

            const expectKey = `${sessionID}:${selectedKey}`;
            if (expectedSelections.delete(expectKey)) continue;
            if (!state.exhausted.has(sessionID)) continue;

            const selectedIndex = chain.findIndex(
              (model) => modelKey(model) === selectedKey
            );
            if (selectedIndex >= 0) state.indices.set(sessionID, selectedIndex);
            else state.indices.delete(sessionID);
            state.exhausted.delete(sessionID);

            if (!autoResume) {
              await persist(ctx, state);
              console.log(
                `[switchblade] session ${sessionID}: model selection cleared exhausted ladder state`
              );
              continue;
            }

            try {
              await ctx.session.synthetic({
                sessionID,
                text: "Continue from where you stopped.",
                description: "Switchblade resume",
                delivery: "queue",
                resume: true,
                metadata: {
                  source: "switchblade",
                  reason: "model-selected-after-exhaustion",
                },
              });
              await persist(ctx, state);
              console.log(
                `[switchblade] session ${sessionID}: queued synthetic continue after model selection`
              );
            } catch (err) {
              state.exhausted.set(sessionID, Date.now());
              await persist(ctx, state);
              console.warn(
                `[switchblade] session ${sessionID}: synthetic resume failed: ${
                  (err as Error)?.message ?? err
                }`
              );
            }
          }
        } catch (err) {
          if (!modelSelectedAbort.signal.aborted) {
            console.warn(
              `[switchblade] model.selected subscription stopped: ${
                (err as Error)?.message ?? err
              }`
            );
          }
        }
      })();
    }

    // Cleanup: dispose hook registrations and the event subscription.
    return () => {
      modelSelectedAbort.abort();
      void retryReg.dispose().catch(() => {});
      void contextReg.dispose().catch(() => {});
      console.log("[switchblade] unloaded");
    };
  },
});
