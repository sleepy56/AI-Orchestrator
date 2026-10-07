import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, AttemptEntry } from "./knowledge";
import { ModelProfile, ModelRegistry, selectModel } from "./models";
import { routeTask } from "./router";
import { TaskSpec } from "./types";
import { PriceSnapshot } from "./model-decisions";
import { CommandService } from "./command-service";

// Written by a trusted local capacity probe or operator. Missing fields remain unknown.
export interface CapacitySignal {
  provider: "codex";
  observedAt: string;
  remainingTokens?: number;
  limitTokens?: number;
  resetAt?: string;
  maxConcurrent?: number;
  retryAfter?: string;
}
export interface SchedulerLimits { maxWorkers: number; maxProjectedCostUsd?: number }
export interface CapacityDecision { limit: number; reason?: string; availability: "known" | "unknown"; estimateTokens?: number }

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}
export function capacityAvailability(signal: CapacitySignal | undefined, now = Date.now()): "known" | "unknown" {
  if (!signal || signal.remainingTokens === undefined) return "unknown";
  const observed = Date.parse(signal.observedAt);
  return observed <= now + 60_000 && now - observed <= 5 * 60_000 &&
    (!signal.resetAt || Date.parse(signal.resetAt) > now) ? "known" : "unknown";
}
async function optionalJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
export async function readCapacity(project: string): Promise<CapacitySignal | undefined> {
  const value = await optionalJson(join(project, ".orch", "capacity.json"));
  if (value === undefined) return undefined;
  const signal = value as CapacitySignal;
  if (!signal || signal.provider !== "codex" || !timestamp(signal.observedAt) ||
      (signal.remainingTokens !== undefined && (!Number.isSafeInteger(signal.remainingTokens) || signal.remainingTokens < 0)) ||
      (signal.limitTokens !== undefined && (!nonnegative(signal.limitTokens) || signal.limitTokens === 0)) ||
      (signal.maxConcurrent !== undefined && (!Number.isSafeInteger(signal.maxConcurrent) || signal.maxConcurrent < 1)) ||
      (signal.resetAt !== undefined && !timestamp(signal.resetAt)) ||
      (signal.retryAfter !== undefined && !timestamp(signal.retryAfter)) ||
      (signal.remainingTokens !== undefined && signal.limitTokens !== undefined && signal.remainingTokens > signal.limitTokens)) throw new Error("Invalid .orch/capacity.json");
  return signal;
}
export async function readSchedulerLimits(project: string): Promise<SchedulerLimits> {
  const value = await optionalJson(join(project, ".orch", "scheduler.json"));
  if (value === undefined) return { maxWorkers: 4 };
  const limits = value as SchedulerLimits;
  if (!limits || !Number.isSafeInteger(limits.maxWorkers) || limits.maxWorkers < 1 || limits.maxWorkers > 32 ||
      (limits.maxProjectedCostUsd !== undefined && !nonnegative(limits.maxProjectedCostUsd))) throw new Error("Invalid .orch/scheduler.json");
  return limits;
}

export class CapacityScheduler {
  private constructor(private readonly project: string, private readonly registry: ModelRegistry,
    private readonly limits: SchedulerLimits, private readonly history: AttemptEntry[],
    private readonly areas: Map<string, string[]>, private readonly prices?: PriceSnapshot,
    private readonly profileForTask?: (task: TaskSpec) => ModelProfile) {}

  static async load(project: string, registry: ModelRegistry, profileForTask?: (task: TaskSpec) => ModelProfile,
    policyMaxCostUsd?: number): Promise<CapacityScheduler> {
    const limits = await readSchedulerLimits(project);
    if (policyMaxCostUsd !== undefined) limits.maxProjectedCostUsd = Math.min(limits.maxProjectedCostUsd ?? Infinity, policyMaxCostUsd);
    const history = (await new KnowledgeStore(project).list("project")).filter((entry): entry is AttemptEntry => entry.kind === "attempt" && !entry.simulated);
    const detail = await new CommandService(project).detail();
    const areas = new Map((detail.plan.value.draft?.tasks ?? []).map((task) => [task.id, task.areas]));
    const prices = await optionalJson(join(project, ".orch", "prices.json")) as PriceSnapshot | undefined;
    return new CapacityScheduler(project, registry, limits, history, areas, prices, profileForTask);
  }

  async decide(task: TaskSpec, inFlight: TaskSpec[]): Promise<CapacityDecision> {
    const signal = await readCapacity(this.project);
    const availability = capacityAvailability(signal);
    if (signal?.retryAfter && Date.parse(signal.retryAfter) > Date.now())
      return { limit: 0, reason: `Provider retry after ${signal.retryAfter}`, availability };
    const estimate = this.estimate(task);
    if (signal?.remainingTokens !== undefined && availability === "unknown")
      return { limit: 0, reason: "Provider capacity measurement is stale; refresh the measured signal", availability, estimateTokens: estimate };
    // A measurement that has expired cannot establish available capacity.
    if (availability === "known" && signal?.remainingTokens !== undefined) {
      const reserve = signal.limitTokens === undefined ? 0 : Math.ceil(signal.limitTokens * 0.1);
      const reserved = inFlight.reduce((sum, worker) => sum + this.estimate(worker), 0);
      if (signal.remainingTokens <= reserve || signal.remainingTokens - reserve < estimate + reserved)
        return { limit: 0, reason: `Provider capacity near exhaustion; remaining ${signal.remainingTokens} measured tokens${signal.resetAt ? `; reset ${signal.resetAt}` : ""}`, availability, estimateTokens: estimate };
    }
    const price = this.price(task);
    const cost = price ? this.estimateCost(task, price) : undefined;
    let limit = Math.min(this.limits.maxWorkers, availableParallelism(), signal?.maxConcurrent ?? 1);
    if (availability === "unknown" || cost === undefined) limit = Math.min(limit, 1);
    if (this.limits.maxProjectedCostUsd !== undefined && cost === undefined)
      return { limit: 0, reason: "Projected cost is unknown; supply a USD price snapshot or remove the cost limit", availability, estimateTokens: estimate };
    if (cost !== undefined && this.limits.maxProjectedCostUsd !== undefined) {
      if (cost > this.limits.maxProjectedCostUsd) return { limit: 0, reason: `Projected task cost exceeds configured limit`, availability, estimateTokens: estimate };
      const concurrentCosts = inFlight.map((worker) => {
        const workerPrice = this.price(worker);
        return workerPrice ? this.estimateCost(worker, workerPrice) : undefined;
      });
      if (concurrentCosts.some((value) => value === undefined) || cost + concurrentCosts.reduce((sum: number, value) => sum + (value ?? 0), 0) > this.limits.maxProjectedCostUsd)
        return { limit: inFlight.length, availability, estimateTokens: estimate };
      if (cost > 0) limit = Math.min(limit, Math.max(1, Math.floor(this.limits.maxProjectedCostUsd / cost)));
    }
    if (task.risk === "critical" || task.difficulty === "extreme" ||
        inFlight.some((other) => other.risk === "critical" || other.difficulty === "extreme")) limit = 1;
    const taskAreas = this.areas.get(task.id);
    if (inFlight.some((other) => !taskAreas?.length || (() => {
      const otherAreas = this.areas.get(other.id);
      return !otherAreas?.length || taskAreas.some((area) => otherAreas.includes(area));
    })())) limit = 1;
    return { limit, availability, estimateTokens: estimate };
  }

  private samples(task: TaskSpec): AttemptEntry[] {
    const profile = this.profileForTask?.(task) ?? selectModel(this.registry, routeTask(task));
    return this.history.filter((row) => row.taskType === task.type && row.difficulty === task.difficulty &&
      row.risk === task.risk && row.model === `${profile.provider}:${profile.model}` && row.route === profile.tier &&
      nonnegative(row.inputTokens) && nonnegative(row.outputTokens));
  }
  private estimate(task: TaskSpec): number {
    const totals = this.samples(task).map((row) => row.inputTokens! + row.outputTokens!);
    // Cold-start task usage is an explicit conservative estimate, never a quota observation.
    if (!totals.length) return { easy: 20_000, moderate: 50_000, hard: 100_000, extreme: 200_000 }[task.difficulty];
    const mean = totals.reduce((sum, value) => sum + value, 0) / totals.length;
    const variance = totals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / totals.length;
    return Math.ceil(Math.max(...totals, mean + 2 * Math.sqrt(variance)) * (totals.length < 8 ? 2 : 1.25));
  }
  private estimateCost(task: TaskSpec, price: { inputPerMillion: number; outputPerMillion: number }): number {
    const rows = this.samples(task);
    // With no comparable sample, charge every estimated token at the dearer
    // rate. This is a conservative cost estimate, not an observed bill.
    if (!rows.length) return this.estimate(task) * Math.max(price.inputPerMillion, price.outputPerMillion) / 1_000_000;
    const costs = rows.map((row) => (row.inputTokens! * price.inputPerMillion + row.outputTokens! * price.outputPerMillion) / 1_000_000);
    const mean = costs.reduce((sum, value) => sum + value, 0) / costs.length;
    const variance = costs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / costs.length;
    return Math.max(...costs, mean + 2 * Math.sqrt(variance)) * (costs.length < 8 ? 2 : 1.25);
  }
  private price(task: TaskSpec): { inputPerMillion: number; outputPerMillion: number } | undefined {
    if (this.prices?.currency !== "USD" || !this.prices.version?.trim()) return undefined;
    const profile = this.profileForTask?.(task) ?? selectModel(this.registry, routeTask(task));
    const price = this.prices?.models?.[`${profile.provider}:${profile.model}`];
    return price && nonnegative(price.inputPerMillion) && nonnegative(price.outputPerMillion) ? price : undefined;
  }
}
