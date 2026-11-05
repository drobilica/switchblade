// Tests for Switchblade's helpers (imported from src/helpers.ts —
// the real implementation, not a re-implementation).
// Run with: npm test   (node --test tests/helpers.test.mjs;
// Node 24 type-strips src/helpers.ts.)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLimitError,
  nextFallback,
  nextAvailableFallback,
  buildChain,
  fallbackErrorKind,
  timeoutSwitchAfterAttempt,
  exhaustedResetMs,
  autoResumeEnabled,
  sanitizeBaseline,
  DEFAULT_FALLBACK,
} from "../src/helpers.ts";

test("isLimitError: 429 status", () => {
  assert.equal(isLimitError({ error: { status: 429 } }), true);
});

test("isLimitError: 402 status", () => {
  assert.equal(isLimitError({ error: { status: 402 } }), true);
});

test("isLimitError: quota message", () => {
  assert.equal(isLimitError({ error: { message: "Quota exceeded for today" } }), true);
});

test("isLimitError: weekly limit message", () => {
  assert.equal(isLimitError({ error: { message: "Weekly limit reached" } }), true);
});

test("isLimitError: rate limit message", () => {
  assert.equal(isLimitError({ error: { message: "Rate limit hit" } }), true);
});

test("isLimitError: matches type field", () => {
  assert.equal(isLimitError({ error: { type: "quota_exceeded" } }), true);
});

test("isLimitError: unrelated error", () => {
  assert.equal(isLimitError({ error: { status: 500, message: "Internal server error" } }), false);
});

test("isLimitError: empty event", () => {
  assert.equal(isLimitError({}), false);
  assert.equal(isLimitError({ error: null }), false);
  assert.equal(isLimitError({ error: { message: "" } }), false);
});

test("nextFallback: advances to next entry", () => {
  const chain = [
    { providerID: "opencode", id: "a" },
    { providerID: "opencode", id: "b" },
  ];
  assert.deepEqual(nextFallback(chain, undefined, -1), { model: chain[0], index: 0 });
  assert.deepEqual(nextFallback(chain, chain[0], 0), { model: chain[1], index: 1 });
});

test("nextFallback: null at end of chain", () => {
  const chain = [{ providerID: "opencode", id: "a" }];
  assert.equal(nextFallback(chain, undefined, 0), null);
  assert.equal(nextFallback(chain, chain[0], 0), null);
});

test("nextFallback: skips current model, including duplicates", () => {
  const chain = [
    { providerID: "opencode", id: "a" },
    { providerID: "opencode", id: "a" },
    { providerID: "opencode", id: "b" },
  ];
  // chain[0] as current at index 0: chain[1] duplicates it, so skip to chain[2].
  assert.deepEqual(nextFallback(chain, chain[0], 0), { model: chain[2], index: 2 });
});

test("buildChain: defaults without options", () => {
  assert.deepEqual(buildChain(undefined), [DEFAULT_FALLBACK]);
  assert.deepEqual(buildChain("latest"), [DEFAULT_FALLBACK]);
  assert.deepEqual(buildChain(null), [DEFAULT_FALLBACK]);
});

test("buildChain: single model option", () => {
  const chain = buildChain({ model: { providerID: "acme", id: "x" } });
  assert.deepEqual(chain, [{ providerID: "acme", id: "x" }]);
});

test("buildChain: fallbacks take precedence over model", () => {
  const chain = buildChain({
    model: { providerID: "acme", id: "x" },
    fallbacks: [
      { providerID: "opencode", id: "a" },
      { providerID: "opencode", id: "b" },
    ],
  });
  assert.deepEqual(chain, [
    { providerID: "opencode", id: "a" },
    { providerID: "opencode", id: "b" },
  ]);
});

test("buildChain: missing providerID/id get defaults", () => {
  assert.deepEqual(buildChain({ model: { id: "only-id" } }), [
    { providerID: "opencode", id: "only-id" },
  ]);
  assert.deepEqual(buildChain({ model: { providerID: "acme" } }), [
    { providerID: "acme", id: "crouton-alpha-free" },
  ]);
});

test("sanitizeBaseline: keeps valid entries, drops invalid", () => {
  assert.deepEqual(
    sanitizeBaseline([
      { providerID: "opencode", id: "a" },
      { providerID: "", id: "b" },
      { id: "c" },
      { providerID: "opencode", id: 42 },
      null,
    ]),
    [{ providerID: "opencode", id: "a" }]
  );
  assert.deepEqual(sanitizeBaseline(null), []);
  assert.deepEqual(sanitizeBaseline({}), []);
});

test("buildChain: committed baseline used when no options", () => {
  const baseline = [
    { providerID: "opencode", id: "free-a", name: "Free A" },
    { providerID: "opencode", id: "free-b" },
    { id: "invalid" },
  ];
  assert.deepEqual(buildChain(undefined, baseline), [
    { providerID: "opencode", id: "free-a" },
    { providerID: "opencode", id: "free-b" },
  ]);
});

test("buildChain: empty or invalid baseline falls back to default", () => {
  assert.deepEqual(buildChain(undefined, []), [DEFAULT_FALLBACK]);
  assert.deepEqual(buildChain(undefined, [{ id: "invalid" }]), [DEFAULT_FALLBACK]);
});

test("buildChain: options take precedence over baseline", () => {
  assert.deepEqual(
    buildChain({ fallbacks: [{ providerID: "acme", id: "x" }] }, [
      { providerID: "opencode", id: "free" },
    ]),
    [{ providerID: "acme", id: "x" }]
  );
});

test("fallbackErrorKind: quota limits", () => {
  assert.equal(fallbackErrorKind({ error: { status: 429 } }), "limit");
  assert.equal(fallbackErrorKind({ error: { status: 402 } }), "limit");
  assert.equal(
    fallbackErrorKind({ error: { message: "weekly quota exceeded" } }),
    "limit"
  );
});

test("fallbackErrorKind: capacity and unavailable", () => {
  assert.equal(fallbackErrorKind({ error: { status: 503 } }), "capacity");
  assert.equal(fallbackErrorKind({ error: { status: 529 } }), "capacity");
  assert.equal(
    fallbackErrorKind({ error: { message: "Model overloaded, try later" } }),
    "capacity"
  );
  assert.equal(
    fallbackErrorKind({ error: { message: "Model unavailable: opencode/x" } }),
    "unavailable"
  );
  assert.equal(
    fallbackErrorKind({ error: { message: "unsupported region" } }),
    "unavailable"
  );
});

test("fallbackErrorKind: timeouts only after configured attempt", () => {
  const timeout = { error: { status: 504 }, attempt: 1 };
  assert.equal(fallbackErrorKind(timeout, 2), null);
  assert.equal(fallbackErrorKind({ ...timeout, attempt: 2 }, 2), "timeout");
  assert.equal(
    fallbackErrorKind(
      { error: { message: "request timed out" }, attempt: 3 },
      2
    ),
    "timeout"
  );
});

test("timeoutSwitchAfterAttempt: validates option", () => {
  assert.equal(timeoutSwitchAfterAttempt(undefined), 2);
  assert.equal(timeoutSwitchAfterAttempt({ timeoutSwitchAfterAttempt: 3 }), 3);
  assert.equal(timeoutSwitchAfterAttempt({ timeoutSwitchAfterAttempt: "4" }), 4);
  assert.equal(timeoutSwitchAfterAttempt({ timeoutSwitchAfterAttempt: 0 }), 2);
  assert.equal(timeoutSwitchAfterAttempt({ timeoutSwitchAfterAttempt: NaN }), 2);
});

test("nextAvailableFallback: skips excluded candidates", () => {
  const chain = [
    { providerID: "opencode", id: "a" },
    { providerID: "opencode", id: "b" },
    { providerID: "opencode", id: "c" },
  ];
  const excluded = new Set(["opencode/b"]);
  assert.deepEqual(nextAvailableFallback(chain, undefined, -1, excluded), {
    model: chain[0],
    index: 0,
  });
  assert.deepEqual(nextAvailableFallback(chain, undefined, 0, excluded), {
    model: chain[2],
    index: 2,
  });
  assert.equal(
    nextAvailableFallback(chain, chain[2], 2, new Set(["opencode/a"])),
    null
  );
});

test("exhaustedResetMs: validates option and defaults to one hour", () => {
  assert.equal(exhaustedResetMs(undefined), 3_600_000);
  assert.equal(exhaustedResetMs({ exhaustedResetMs: 86_400_000 }), 86_400_000);
  assert.equal(exhaustedResetMs({ exhaustedResetMs: "60000" }), 60_000);
  assert.equal(exhaustedResetMs({ exhaustedResetMs: 0 }), 3_600_000);
  assert.equal(exhaustedResetMs({ exhaustedResetMs: "invalid" }), 3_600_000);
});

test("autoResumeEnabled: defaults true, false disables", () => {
  assert.equal(autoResumeEnabled(undefined), true);
  assert.equal(autoResumeEnabled({}), true);
  assert.equal(autoResumeEnabled({ autoResume: true }), true);
  assert.equal(autoResumeEnabled({ autoResume: false }), false);
});
