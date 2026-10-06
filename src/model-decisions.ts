import { AttemptEntry } from "./knowledge";
import { ModelProfile, ModelRegistry, selectModel } from "./models";
import { routeTask } from "./router";
import { TaskSpec } from "./types";

export interface PriceSnapshot {
  version: string;
  currency: string;
  models: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
}

export interface RouteEvidence {
  alias: string;
  model: string;
  route: string;
  taskCount: number;
  attemptCount: number;
  validatedPasses: number;
  retries: number;
  passRate: number;
  passRate95: [number, number];
  averageInputTokens: number;
  averageOutputTokens: number;
  averageLatencyMs: number;
  averageCostPerTask: number;
  evidenceIds: string[];
}

export interface RouteProposal {
  chosenAlias: string;
  fallbackAlias: string;
  recommendedAlias?: string;
  reason: string;
  uncertainty: string;
  priceVersion?: string;
  currency?: string;
  baseline?: RouteEvidence;
  candidate?: RouteEvidence;
}

type Observation = Pick<AttemptEntry, "taskId" | "taskType" | "difficulty" | "risk" | "route" | "model" | "passed" | "simulated" | "inputTokens" | "outputTokens" | "latencyMs"> & {
  id?: string;
  sourceRunId?: string | null;
  attemptNumber?: number;
  attempt?: number;
};

export interface RouteProposalInput {
  task: TaskSpec;
  registry: ModelRegistry;
  attempts: Observation[];
  prices?: PriceSnapshot;
  manualAlias?: string;
}

const MIN_TASKS = 8;
const UNCERTAINTY = "Where qualifying samples exist, Wilson 95% intervals describe observed validation rates only. Different tasks and checks may have been used on each route; these observations do not establish semantic quality or that another route would pass this task. Cost reprices recorded tokens using the supplied snapshot and is not a billing claim.";

function validMeasure(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function priceFor(snapshot: PriceSnapshot | undefined, profile: ModelProfile) {
  if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version.trim() ||
      typeof snapshot.currency !== "string" || !snapshot.currency.trim() || !snapshot.models || typeof snapshot.models !== "object") return undefined;
  const price = snapshot.models[`${profile.provider}:${profile.model}`];
  return price && validMeasure(price.inputPerMillion) && validMeasure(price.outputPerMillion) ? price : undefined;
}

function wilson95(passed: number, total: number): [number, number] {
  const z = 1.96;
  const p = passed / total;
  const denominator = 1 + z * z / total;
  const middle = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return [Math.max(0, middle - margin), Math.min(1, middle + margin)];
}

function evidence(profile: ModelProfile, input: RouteProposalInput): RouteEvidence | undefined {
  const price = priceFor(input.prices, profile);
  if (!price) return undefined;
  const groups = new Map<string, Observation[]>();
  const seen = new Set<string>();
  for (const row of input.attempts) {
    if (row.simulated !== false || row.taskType !== input.task.type || row.difficulty !== input.task.difficulty ||
        row.risk !== input.task.risk || row.route !== profile.tier || row.model !== `${profile.provider}:${profile.model}` ||
        typeof row.taskId !== "string" || !row.taskId || typeof row.passed !== "boolean") continue;
    const taskKey = `${row.sourceRunId ?? "legacy"}\u0000${row.taskId}`;
    const identity = row.id ?? `${taskKey}\u0000${row.attemptNumber ?? row.attempt ?? "unknown"}\u0000${row.route}\u0000${row.model}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const group = groups.get(taskKey) ?? [];
    group.push(row);
    groups.set(taskKey, group);
  }
  if (groups.size < MIN_TASKS) return undefined;
  const rows = [...groups.values()].flat();
  // Missing usage or time can bias a comparison. Do not replace missing values with zero.
  if (rows.some((row) => !validMeasure(row.inputTokens) || !validMeasure(row.outputTokens) || !validMeasure(row.latencyMs))) return undefined;
  const passed = [...groups.values()].filter((group) => group.some((row) => row.passed)).length;
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens!, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens!, 0);
  const latency = rows.reduce((sum, row) => sum + row.latencyMs!, 0);
  return {
    alias: profile.alias, model: `${profile.provider}:${profile.model}`, route: profile.tier,
    taskCount: groups.size, attemptCount: rows.length, validatedPasses: passed,
    retries: rows.length - groups.size, passRate: passed / groups.size, passRate95: wilson95(passed, groups.size),
    averageInputTokens: inputTokens / groups.size, averageOutputTokens: outputTokens / groups.size,
    averageLatencyMs: latency / groups.size,
    averageCostPerTask: (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / (1_000_000 * groups.size),
    evidenceIds: rows.map((row) => row.id).filter((id): id is string => Boolean(id)),
  };
}

export function recommendModelRoute(input: RouteProposalInput): RouteProposal {
  const fallback = selectModel(input.registry, routeTask(input.task));
  const manual = input.manualAlias === undefined ? undefined : input.registry.models.find((profile) => profile.alias === input.manualAlias);
  if (input.manualAlias !== undefined && (!manual || !manual.enabled || manual.provider !== "codex")) {
    throw new Error(`Unavailable manual model alias: ${input.manualAlias}`);
  }
  const result: RouteProposal = {
    chosenAlias: manual?.alias ?? fallback.alias, fallbackAlias: fallback.alias,
    reason: "Insufficient comparable live validated evidence or known versioned prices; established route retained.",
    uncertainty: UNCERTAINTY,
  };
  if (manual) {
    result.reason = "Manual model override retained; automatic route proposals do not replace it.";
    return result;
  }
  const baseline = evidence(fallback, input);
  if (!baseline) return result;
  result.baseline = baseline;
  result.priceVersion = input.prices!.version;
  result.currency = input.prices!.currency;
  const alternatives = input.registry.models.filter((profile) => profile.enabled && profile.provider === "codex" &&
    (profile.tier !== fallback.tier || profile.model !== fallback.model))
    .map((profile) => evidence(profile, input)).filter((item): item is RouteEvidence => Boolean(item))
    // A candidate failure may incur a later fallback on another route. That cost
    // is not attributable from route-only evidence, so require every observed
    // candidate task to have a validated pass on this route.
    .filter((item) => item.validatedPasses === item.taskCount && item.passRate >= baseline.passRate &&
      item.averageCostPerTask < baseline.averageCostPerTask * 0.9 &&
      item.averageLatencyMs <= baseline.averageLatencyMs * 1.25 &&
      item.retries / item.taskCount <= baseline.retries / baseline.taskCount + 0.25)
    .sort((a, b) => a.averageCostPerTask - b.averageCostPerTask || a.alias.localeCompare(b.alias));
  const candidate = alternatives[0];
  if (!candidate) {
    result.reason = `No cheaper comparable route met observed validation, retry, latency, and cost limits (${baseline.taskCount} baseline tasks; price snapshot ${input.prices!.version}).`;
    return result;
  }
  result.candidate = candidate;
  result.recommendedAlias = candidate.alias;
  result.reason = `Proposal from comparable live validated outcomes: ${candidate.validatedPasses}/${candidate.taskCount} candidate tasks and ${baseline.validatedPasses}/${baseline.taskCount} baseline tasks passed; ${candidate.retries} vs ${baseline.retries} retries. Observed token, latency, and retry-adjusted cost averages use price snapshot ${input.prices!.version}. Keep ${fallback.alias} as fallback.`;
  return result;
}
