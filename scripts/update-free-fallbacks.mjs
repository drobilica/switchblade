#!/usr/bin/env node
// Generate src/free-fallbacks.json from the local OpenCode model catalog.
// Requires a reachable OpenCode server and an authenticated account:
//   npm run update:models
//
// The generated file contains no credentials, headers, or org IDs.

import { execFileSync } from "node:child_process";
import { writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src", "free-fallbacks.json");

function isZeroCost(tier) {
  const zero = (number) => number == null || number === 0;
  return (
    zero(tier?.input) &&
    zero(tier?.output) &&
    zero(tier?.cache?.read) &&
    zero(tier?.cache?.write)
  );
}

const raw = execFileSync("opencode", ["api", "get", "/api/model"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const catalog = JSON.parse(raw);
const data = Array.isArray(catalog?.data) ? catalog.data : [];

const selected = data
  .filter(
    (model) =>
      model?.type === "chat" &&
      model?.enabled !== false &&
      model?.status === "active" &&
      model?.capabilities?.tools === true &&
      Array.isArray(model?.cost) &&
      model.cost.length > 0 &&
      model.cost.every(isZeroCost)
  )
  .map((model) => ({
    providerID: model.providerID,
    id: model.id,
    name: model.name,
    releaseDate: Number.isFinite(model?.time?.released)
      ? new Date(model.time.released).toISOString().slice(0, 10)
      : null,
    context: model?.limit?.context ?? null,
    output: model?.limit?.output ?? null,
  }))
  .sort((a, b) => {
    const released = String(b.releaseDate ?? "").localeCompare(
      String(a.releaseDate ?? "")
    );
    if (released !== 0) return released;
    const context = (b.context ?? 0) - (a.context ?? 0);
    if (context !== 0) return context;
    return (
      `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`)
    );
  });

const document = {
  generatedAt: new Date().toISOString(),
  source: "opencode api get /api/model",
  filter: {
    type: "chat",
    enabled: true,
    status: "active",
    tools: true,
    zeroCost: true,
  },
  fallbacks: selected,
};

const temporary = `${target}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
renameSync(temporary, target);

console.log(`[switchblade] wrote ${selected.length} free fallbacks to ${target}`);
for (const model of selected) {
  console.log(
    `[switchblade] ${model.providerID}/${model.id} (${model.releaseDate ?? "unknown"})`
  );
}
