import { PriceSnapshot, RouteEvidence, RouteProposal, routeEvidence } from "./model-decisions";
import { ModelProfile, ModelRegistry, selectModel } from "./models";
import { routeTask } from "./router";
import { Route, TaskSpec } from "./types";
import { AttemptEntry } from "./knowledge";

export interface RouteLimits {
  allowedProviders?: Array<"codex" | "claude">;
  blockedModels?: string[];
  maxCostPerTaskUsd?: number;
}
export interface RouteRule { alias: string; fallbackAlias: string }
export interface RoutingState { limits: RouteLimits; rules: Record<string, RouteRule> }
export interface PolicyRevision {
  version: number;
  at: string;
  author: "user" | "orch";
  cause: "limits" | "live-outcomes" | "rollback";
  reason: string;
  before: RoutingState;
  after: RoutingState;
  evidenceIds: string[];
  priceVersion?: string;
  currency?: string;
  baseline?: RouteEvidence;
  candidate?: RouteEvidence;
  rollbackTo: number;
}

export function routeKey(task: TaskSpec): string { return `${task.type}:${task.difficulty}:${task.risk}`; }
export function emptyRouting(): RoutingState { return { limits: {}, rules: {} }; }

export function parseLimits(value: unknown): RouteLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Limits need an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["allowedProviders", "blockedModels", "maxCostPerTaskUsd"].includes(key))) throw new Error("Unknown routing limit");
  const result: RouteLimits = {};
  if (input.allowedProviders !== undefined) {
    if (!Array.isArray(input.allowedProviders) || !input.allowedProviders.length ||
      input.allowedProviders.some((provider) => provider !== "codex" && provider !== "claude")) throw new Error("Invalid allowed providers");
    result.allowedProviders = [...new Set(input.allowedProviders)];
  }
  if (input.blockedModels !== undefined) {
    if (!Array.isArray(input.blockedModels) || input.blockedModels.some((model) => typeof model !== "string" || !/^[a-z0-9_.:-]+$/i.test(model))) throw new Error("Invalid blocked models");
    result.blockedModels = [...new Set(input.blockedModels)];
  }
  if (input.maxCostPerTaskUsd !== undefined) {
    if (typeof input.maxCostPerTaskUsd !== "number" || !Number.isFinite(input.maxCostPerTaskUsd) || input.maxCostPerTaskUsd < 0) throw new Error("Invalid maximum task cost");
    result.maxCostPerTaskUsd = input.maxCostPerTaskUsd;
  }
  return result;
}

export function allowedProfile(profile: ModelProfile, limits: RouteLimits, task: TaskSpec,
  registry: ModelRegistry, attempts: AttemptEntry[], prices?: PriceSnapshot): { allowed: boolean; reason?: string; evidence?: RouteEvidence } {
  if (!profile.enabled || profile.provider !== "codex") return { allowed: false, reason: "Profile is unavailable" };
  if (limits.allowedProviders && !limits.allowedProviders.includes(profile.provider)) return { allowed: false, reason: "Provider is outside user limits" };
  if (limits.blockedModels?.includes(`${profile.provider}:${profile.model}`) || limits.blockedModels?.includes(profile.model) || limits.blockedModels?.includes(profile.alias))
    return { allowed: false, reason: "Model is blocked by user limits" };
  if (limits.maxCostPerTaskUsd === undefined) return { allowed: true };
  if (prices?.currency !== "USD") return { allowed: false, reason: "A known USD price snapshot is required by the spend limit" };
  const evidence = routeEvidence(profile, { task, registry, attempts, prices });
  if (!evidence) return { allowed: false, reason: "Comparable live cost evidence is required by the spend limit" };
  if (evidence.maximumObservedCostPerTask > limits.maxCostPerTaskUsd) return { allowed: false, reason: "Observed retry-adjusted task cost exceeds user limit", evidence };
  return { allowed: true, evidence };
}

export function constrainProposal(proposal: RouteProposal, task: TaskSpec, state: RoutingState, registry: ModelRegistry,
  attempts: AttemptEntry[], prices?: PriceSnapshot): RouteProposal {
  if (!proposal.recommendedAlias && proposal.chosenAlias !== proposal.fallbackAlias) {
    const manual = registry.models.find((item) => item.alias === proposal.chosenAlias);
    const check = manual && allowedProfile(manual, state.limits, task, registry, attempts, prices);
    if (!check || !check.allowed) throw new Error(`Manual route violates user limits: ${check?.reason ?? "unavailable"}`);
  }
  if (!proposal.recommendedAlias) return proposal;
  for (const alias of [proposal.recommendedAlias, proposal.fallbackAlias]) {
    const profile = registry.models.find((item) => item.alias === alias);
    const check = profile && allowedProfile(profile, state.limits, task, registry, attempts, prices);
    if (!check || !check.allowed) return { ...proposal, recommendedAlias: undefined,
      reason: `Automatic route rejected by user limits for ${alias}: ${check?.reason ?? "unavailable"}` };
  }
  return proposal;
}

export function resolveRoute(task: TaskSpec, route: Route, attempt: number, state: RoutingState, registry: ModelRegistry,
  attempts: AttemptEntry[], prices?: PriceSnapshot): { profile: ModelProfile; route: Route; fallbackAlias: string; constraint?: string } {
  const rule = attempt === 1 ? state.rules[routeKey(task)] : undefined;
  const aliases = rule ? [rule.alias, rule.fallbackAlias] : [selectModel(registry, route).alias];
  let constraint: string | undefined;
  for (const alias of [...new Set(aliases)]) {
    const profile = registry.models.find((item) => item.alias === alias);
    if (!profile) { constraint = `Route alias ${alias} is unavailable`; continue; }
    const result = allowedProfile(profile, state.limits, task, registry, attempts, prices);
    if (!result.allowed) { constraint = result.reason; continue; }
    const [worker, effort] = profile.tier.split("-") as [Route["worker"], Route["effort"]];
    return { profile, route: { worker, effort, label: profile.tier }, fallbackAlias: rule?.fallbackAlias ?? aliases[0],
      ...(alias !== aliases[0] ? { constraint } : {}) };
  }
  throw new Error(`No permitted model route for ${task.id}: ${constraint ?? "none available"}`);
}
