// Tests for Switchblade's helpers (imported from src/helpers.ts —
// the real implementation, not a re-implementation).
// Run with: npm test   (node --test tests/helpers.test.mjs;
// Node 24 type-strips src/helpers.ts.)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLimitError,
  nextFallback,
  buildChain,
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
