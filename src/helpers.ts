// Switchblade — pure helpers (no @opencode/plugin imports) so they can be
// unit-tested directly with node --test on Node 22.6+/24+ via type stripping.

export type SwitchbladeModel = {
  providerID: string;
  id: string;
};

export type SwitchbladeOptions = {
  model?: SwitchbladeModel;
  fallbacks?: SwitchbladeModel[];
  /** Switch to the next fallback after this many physical attempts on a timeout. Defaults to 2. */
  timeoutSwitchAfterAttempt?: number;
};



export const DEFAULT_FALLBACK: SwitchbladeModel = {
  providerID: "opencode",
  id: "crouton-alpha-free",
};

// Substrings that suggest a provider rate/weekly/quota/billing limit.
export const LIMIT_MESSAGE_PATTERN =
  /quota|weekly|rate limit|limit exceeded|insufficient|billing|over capacity|resource exhausted|too many requests/i;

// Substrings that suggest the service is at capacity.
export const CAPACITY_MESSAGE_PATTERN =
  /capacity|overloaded|overload|oversubscribed|high demand|busy|temporarily unavailable|service unavailable|try again later/i;

// Substrings that suggest the model itself is unavailable/disabled/not offered.
export const UNAVAILABLE_MESSAGE_PATTERN =
  /model unavailable|model not available|no model available|model.*disabled|disabled.*model|model.*hidden|unsupported region|not available in|not offered in|unavailable in/i;

// Substrings that suggest a timeout or reset connection.
export const TIMEOUT_MESSAGE_PATTERN =
  /timeout|timed out|timedout|deadline exceeded|connection reset|socket hang up|econnreset|gateway timeout/i;

type ErrorLike = {
  error?: { status?: number; type?: string; message?: string } | null;
  message?: string;
  attempt?: number;
};

const errorParts = (event: ErrorLike): string[] =>
  [event.error?.message, event.error?.type, event.message].filter(
    (part): part is string => typeof part === "string"
  );

/** Return true if the retry event looks like a rate / weekly / quota limit. */
export function isLimitError(event: ErrorLike): boolean {
  const status = event.error?.status;
  if (status === 429 || status === 402) return true;
  return errorParts(event).some((part) => LIMIT_MESSAGE_PATTERN.test(part));
}

/** Return true if the retry event looks like a capacity/overload failure. */
export function isCapacityError(event: ErrorLike): boolean {
  const status = event.error?.status;
  if (status === 503 || status === 529) return true;
  return errorParts(event).some((part) => CAPACITY_MESSAGE_PATTERN.test(part));
}

/** Return true if the retry event looks like the model is unavailable/disabled. */
export function isUnavailableError(event: ErrorLike): boolean {
  const status = event.error?.status;
  if (status === 404 && /model/i.test([
    event.error?.message,
    event.error?.type,
    event.message,
  ].filter((part): part is string => typeof part === 'string').join(' '))) {
    return true;
  }
  return errorParts(event).some((part) => UNAVAILABLE_MESSAGE_PATTERN.test(part));
}

/** Return true if the retry event looks like a timeout/reset failure. */
export function isTimeoutError(event: ErrorLike): boolean {
  const status = event.error?.status;
  if (status === 408 || status === 504) return true;
  return errorParts(event).some((part) => TIMEOUT_MESSAGE_PATTERN.test(part));
}

export type FallbackErrorKind =
  | "limit"
  | "capacity"
  | "unavailable"
  | "timeout";

/**
 * Classify the retry event. Returning a kind means it is worth trying another
 * model; timeouts only qualify after the configured attempt.
 */
export function fallbackErrorKind(
  event: ErrorLike,
  timeoutSwitchAfterAttempt = 2
): FallbackErrorKind | null {
  if (isLimitError(event)) return "limit";
  if (isUnavailableError(event)) return "unavailable";
  if (isCapacityError(event)) return "capacity";
  if (isTimeoutError(event)) {
    const attempt = Number.isFinite(event.attempt) ? Number(event.attempt) : 1;
    return attempt >= timeoutSwitchAfterAttempt ? "timeout" : null;
  }
  return null;
}

/** Return true when a switchModel() failure is likely to be resolved by another candidate. */
export function isUnavailableSwitchFailure(error: unknown): boolean {
  const message =
    error && typeof error === "object"
      ? String((error as { message?: unknown }).message ?? error)
      : String(error ?? "");
  return fallbackErrorKind({ error: { message } }, 1) === "unavailable";
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

/**
 * Same as nextFallback, but also skips keys present in `excluded`. This is the
 * helper used at runtime so a candidate which rejects switchModel() can be
 * bypassed without mutating the committed baseline.
 */
export function nextAvailableFallback(
  chain: SwitchbladeModel[],
  current: SwitchbladeModel | undefined,
  index: number,
  excluded: ReadonlySet<string>
): { model: SwitchbladeModel; index: number } | null {
  for (let i = index + 1; i < chain.length; i++) {
    const candidate = chain[i];
    if (excluded.has(`${candidate.providerID}/${candidate.id}`)) continue;
    if (
      current &&
      current.providerID === candidate.providerID &&
      current.id === candidate.id
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

/** Return true when options contain an explicit model/fallback chain override. */
export function hasExplicitFallbackOptions(options: unknown): boolean {
  if (options == null || typeof options !== "object") return false;
  const opts = options as SwitchbladeOptions;
  return (
    (Array.isArray(opts.fallbacks) && opts.fallbacks.length > 0) ||
    opts.model != null
  );
}

/** Normalize timeoutSwitchAfterAttempt from options; invalid values use the default. */
export function timeoutSwitchAfterAttempt(options: unknown): number {
  if (options != null && typeof options === "object") {
    const raw = (options as SwitchbladeOptions).timeoutSwitchAfterAttempt;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return 2;
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
