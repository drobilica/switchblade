// Validate the committed free-model baseline without OpenCode access.
// This catches malformed or secret-containing generated JSON at test/CI time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sanitizeBaseline } from "../src/helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "src", "free-fallbacks.json");

test("free-fallbacks.json is valid JSON with at least one model", () => {
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.ok(parsed && typeof parsed === "object", "baseline must be an object");
  assert.ok(Array.isArray(parsed.fallbacks), "baseline.fallbacks must be an array");
  const models = sanitizeBaseline(parsed.fallbacks);
  assert.ok(models.length > 0, "baseline must contain at least one valid model");
});

test("free-fallbacks.json does not contain credentials or headers", () => {
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  const forbidden = ["apiKey", "headers", "x-opencode-org-id", "authorization", "settings"];
  const text = JSON.stringify(parsed);
  for (const token of forbidden) {
    assert.equal(
      text.toLowerCase().includes(token.toLowerCase()),
      false,
      `baseline must not contain ${token}`
    );
  }
});

test("free-fallbacks.json entries are all zero-cost-compatible references", () => {
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  for (const model of parsed.fallbacks) {
    assert.ok(model.providerID && typeof model.providerID === "string");
    assert.ok(model.id && typeof model.id === "string");
    // No endpoint URLs or credential fields belong in the fallback reference list.
    assert.equal(Object.hasOwn(model, "baseURL"), false);
    assert.equal(Object.hasOwn(model, "apiKey"), false);
  }
});
