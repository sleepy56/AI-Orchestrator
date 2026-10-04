import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effort, Route } from "./types";

export type ProviderId = "codex" | "claude";

export interface ModelProfile {
  alias: string;
  provider: ProviderId;
  model: string;
  tier: Route["label"];
  effort: Effort;
  enabled: boolean;
  weight: number;
}

export interface ModelRegistry {
  version: 1;
  policyVersion?: number;
  models: ModelProfile[];
}

export function defaultRegistry(): ModelRegistry {
  return {
    version: 1,
    policyVersion: 1,
    models: [
      { alias: "luna-low", provider: "codex", model: "gpt-6-luna", tier: "luna-low", effort: "low", enabled: true, weight: 1 },
      { alias: "sol-medium", provider: "codex", model: "gpt-6-sol", tier: "sol-medium", effort: "medium", enabled: true, weight: 1 },
      { alias: "sol-high", provider: "codex", model: "gpt-6-sol", tier: "sol-high", effort: "high", enabled: true, weight: 1 },
      { alias: "sol-xhigh", provider: "codex", model: "gpt-6-sol", tier: "sol-xhigh", effort: "xhigh", enabled: true, weight: 1 },
      { alias: "claude-placeholder", provider: "claude", model: "", tier: "sol-high", effort: "high", enabled: false, weight: 1 },
    ],
  };
}

export function registryPath(project: string): string {
  return join(project, ".orch", "models.json");
}

export async function loadRegistry(project: string): Promise<ModelRegistry> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(registryPath(project), "utf8"));
  } catch (error) {
    if (isMissing(error)) return defaultRegistry();
    throw error;
  }
  if (!value || typeof value !== "object" || (value as ModelRegistry).version !== 1 || !Array.isArray((value as ModelRegistry).models)) {
    throw new Error("Invalid .orch/models.json");
  }
  const registry = value as ModelRegistry;
  if (registry.policyVersion !== undefined && (!Number.isSafeInteger(registry.policyVersion) || registry.policyVersion < 1)) {
    throw new Error("Invalid model policy version");
  }
  for (const model of registry.models) validateProfile(model);
  if (new Set(registry.models.map((model) => model.alias)).size !== registry.models.length) {
    throw new Error("Duplicate model alias in .orch/models.json");
  }
  return registry;
}

export async function saveRegistry(project: string, registry: ModelRegistry): Promise<void> {
  for (const model of registry.models) validateProfile(model);
  const target = registryPath(project);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function selectModel(registry: ModelRegistry, route: Route): ModelProfile {
  const candidates = registry.models.filter((model) => model.tier === route.label && model.enabled && model.provider === "codex");
  candidates.sort((a, b) => b.weight - a.weight || a.alias.localeCompare(b.alias));
  const selected = candidates[0];
  if (!selected) throw new Error(`No enabled Codex model for ${route.label}. Use orch models add or orch models enable.`);
  return selected;
}

export function validateProfile(model: ModelProfile): void {
  if (!model || typeof model.alias !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(model.alias)) throw new Error("Invalid model alias");
  if (model.provider !== "codex" && model.provider !== "claude") throw new Error(`Invalid provider for ${model.alias}`);
  if (model.provider === "claude" && model.enabled) throw new Error("Claude execution is unavailable; keep Claude models disabled");
  if (typeof model.model !== "string" || (model.enabled && !model.model.trim())) throw new Error(`Invalid model ID for ${model.alias}`);
  if (!/^(luna|sol)-(low|medium|high|xhigh)$/.test(model.tier)) throw new Error(`Invalid tier for ${model.alias}`);
  if (!["low", "medium", "high", "xhigh"].includes(model.effort)) throw new Error(`Invalid effort for ${model.alias}`);
  if (typeof model.enabled !== "boolean" || !Number.isFinite(model.weight) || model.weight < 0 || model.weight > 10) {
    throw new Error(`Invalid availability or weight for ${model.alias}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
