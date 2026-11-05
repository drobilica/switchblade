// Switchblade — OpenCode server plugin for provider failure fallback.
//
// On quota/rate limits (429/402), capacity/overload failures (503/529), or
// model-unavailable errors, Switchblade switches the session to the next model
// in the fallback ladder and sets decision.retry so the request retries.
// Timeouts are also eligible after the configured attempt.
//
// Default ladder: src/free-fallbacks.json, generated from the local model
// catalog with `npm run update:models` and validated at load time. Runtime
// switchModel() failures are skipped on the next attempt without mutating the
// committed baseline.
//
// Default ladder: src/free-fallbacks.json, generated from the local model
// catalog with `npm run update:models` and validated at load time. A session
// only walks the committed free models, minus any now disabled/unavailable.
//
// Configuration (object form of `plugins` in opencode.jsonc):
//   model:     { providerID?, id? }  — single fallback override
//   fallbacks: [ { providerID?, id? }, ... ] — chained fallback override
//   timeoutSwitchAfterAttempt: 2      — switch on timeout after N physical attempts
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
  type SwitchbladeModel,
} from "./helpers.ts";

const STORAGE_KEY = "sessions";

type SwitchMap = Map<string, number>;

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

async function loadPersisted(ctx: any): Promise<SwitchMap> {
  const map: SwitchMap = new Map();
  try {
    const raw = await ctx.storage?.get?.(STORAGE_KEY);
    const obj =
      typeof raw === "string"
        ? JSON.parse(raw)
        : (raw as Record<string, number>);
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "number" && Number.isFinite(v)) map.set(k, v);
      }
    }
  } catch {
    // Corrupt / unreadable storage: start fresh, don't crash the plugin.
  }
  return map;
}

async function persist(ctx: any, map: SwitchMap): Promise<void> {
  try {
    await ctx.storage?.set?.(STORAGE_KEY, Object.fromEntries(map));
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

    // Per-session switched index: -1 = never switched, >= 0 = index into chain.
    const switched: SwitchMap = await loadPersisted(ctx);

    console.log(
      `[switchblade] loaded, fallback chain: ${chain
        .map((m) => `${m.providerID}/${m.id}`)
        .join(" -> ")}`
    );

    // Retry hook: switch to the next usable fallback when OpenCode reports a
    // quota/rate/capacity/unavailable/timeout condition.
    const retryReg = await ctx.session.hook("retry", async (event: any) => {
      const kind = fallbackErrorKind(event, timeoutAfter);
      if (!kind || chain.length === 0) return;

      const sessionID: string = event.sessionID;
      const index = switched.get(sessionID) ?? -1;
      const blocked = new Set(unavailableKeys);

      let candidate = nextAvailableFallback(chain, event.model, index, blocked);
      while (candidate) {
        try {
          await ctx.session.switchModel({
            sessionID,
            model: candidate.model,
          });
        } catch (err) {
          const key = modelKey(candidate.model);
          blocked.add(key);
          if (isUnavailableSwitchFailure(err)) unavailableKeys.add(key);
          console.warn(
            `[switchblade] session ${sessionID}: fallback candidate ${key} rejected (${isUnavailableSwitchFailure(err) ? "unavailable" : "unknown failure"}); trying next candidate`
          );
          candidate = nextAvailableFallback(
            chain,
            event.model,
            candidate.index,
            blocked
          );
          continue;
        }

        switched.set(sessionID, candidate.index);
        await persist(ctx, switched);
        console.log(
          `[switchblade] session ${sessionID}: ${kind} failure, switched to ${modelKey(candidate.model)} (attempt ${event.attempt}), retrying immediately`
        );
        event.decision = { retry: true, delay: 0 };
        return;
      }

      console.warn(
        `[switchblade] session ${sessionID}: no switchable fallback remains for ${kind} failure; leaving retry to OpenCode`
      );
    });

    // Context hook: remind the agent (and user) when this session switched.
    const contextReg = await ctx.session.hook("context", (event: any) => {
      const index = switched.get(event.sessionID);
      if (index == null || index < 0) return;
      const current = chain[index];
      if (!current) return;

      event.system.push({
        type: "text",
        text: `[switchblade] This session was moved to ${current.providerID}/${current.id} after the previous model hit an availability, capacity, quota, or timeout limit. Continue your work normally; do not mention this note to the user.`,
      });
    });

    // Cleanup: dispose hook registrations on plugin teardown.
    return () => {
      void retryReg.dispose().catch(() => {});
      void contextReg.dispose().catch(() => {});
      console.log("[switchblade] unloaded");
    };
  },
});
