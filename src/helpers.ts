// Switchblade — pure helpers (no @opencode/plugin imports) so they can be
// unit-tested directly with node --test on Node 22.6+/24+ via type stripping.

export type SwitchbladeModel = {
  providerID: string;
  id: string;
};

export type SwitchbladeOptions = {
  model?: SwitchbladeModel;
  fallbacks?: SwitchbladeModel[];
};



export const DEFAULT_FALLBACK: SwitchbladeModel = {
  providerID: "opencode",
  id: "crouton-alpha-free",
};

// Substrings that suggest a provider rate/weekly/quota/billing limit.
export const LIMIT_MESSAGE_PATTERN =
  /quota|weekly|rate limit|limit exceeded|insufficient|billing|over capacity/i;

/** Return true if the retry event looks like a rate / weekly / quota limit. */
export function isLimitError(event: {
  error?: { status?: number; type?: string; message?: string } | null;
  message?: string;
}): boolean {
  const status = event.error?.status;
  if (status === 429 || status === 402) return true;

  const parts = [event.error?.message, event.error?.type, event.message];
  return parts.some(
    (part) => typeof part === "string" && LIMIT_MESSAGE_PATTERN.test(part)
  );
}

/**
 * Return the next fallback model after position `index` in `chain`, skipping
 * any entry equal to `current`. Returns null when the chain is exhausted.
 * The result carries the chain index so callers never need `indexOf`.
 */
export function nextFallback(
  chain: SwitchbladeModel[],
  current: SwitchbladeModel | undefined,
  index: number
): { model: SwitchbladeModel; index: number } | null {
  for (let i = index + 1; i < chain.length; i++) {
    const candidate = chain[i];
    if (
      current &&
      candidate.providerID === current.providerID &&
      candidate.id === current.id
    ) {
      continue;
    }
    return { model: candidate, index: i };
  }
  return null;
}

/** Defensively coerce an unknown model-ish object into a SwitchbladeModel. */
export function toModel(value: unknown): SwitchbladeModel | null {
  if (value == null || typeof value !== "object") return null;
  const v = value as { providerID?: unknown; id?: unknown; provider?: unknown };
  const id = typeof v.id === "string" && v.id.length > 0 ? v.id : DEFAULT_FALLBACK.id;
  const providerID =
    typeof v.providerID === "string" && v.providerID.length > 0
      ? v.providerID
      : typeof v.provider === "string" && v.provider.length > 0
        ? v.provider
        : DEFAULT_FALLBACK.providerID;
  return { providerID, id };
}

/** Strictly validate a model entry; never fills in defaults. */
export function toStrictModel(value: unknown): SwitchbladeModel | null {
  if (value == null || typeof value !== "object") return null;
  const v = value as { providerID?: unknown; id?: unknown };
  if (typeof v.providerID !== "string" || v.providerID.length === 0) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  return { providerID: v.providerID, id: v.id };
}

/** Validate a baseline array (e.g. from free-fallbacks.json). */
export function sanitizeBaseline(value: unknown): SwitchbladeModel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toStrictModel)
    .filter((model): model is SwitchbladeModel => model !== null);
}

/** Build the fallback chain from options, then the committed baseline, then the default. */
export function buildChain(options: unknown, baseline?: unknown): SwitchbladeModel[] {
  if (options != null && typeof options === "object") {
    const opts = options as SwitchbladeOptions;

    if (Array.isArray(opts.fallbacks) && opts.fallbacks.length > 0) {
      const chain = opts.fallbacks
        .map(toModel)
        .filter((m): m is SwitchbladeModel => m != null);
      if (chain.length > 0) return chain;
    }

    if (opts.model != null) {
      const single = toModel(opts.model);
      if (single) return [{ ...single }];
    }
  }

  const committed = sanitizeBaseline(baseline);
  if (committed.length > 0) return committed;

  return [{ ...DEFAULT_FALLBACK }];
}
