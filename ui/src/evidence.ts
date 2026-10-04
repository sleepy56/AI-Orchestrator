import type { HistoryAttempt, Model } from "./api";

export interface EvidenceSummary {
  attempts: number;
  passed: number;
  repeatedAttempts: number;
  tokenTotal?: number;
  tokenSamples: number;
  averageLatencyMs?: number;
  latencySamples: number;
}

export function modelKey(model: Pick<Model, "provider" | "model" | "tier">): string {
  return `${model.provider}:${model.model}|${model.tier}`;
}

export function attemptKey(attempt: HistoryAttempt): string | undefined {
  return attempt.model ? `${attempt.model}|${attempt.route}` : undefined;
}

export function summarize(attempts: HistoryAttempt[]): EvidenceSummary {
  const taskIds = new Set<string>();
  let repeatedAttempts = 0;
  let tokenTotal = 0;
  let tokenSamples = 0;
  let latencyTotal = 0;
  let latencySamples = 0;
  for (const attempt of attempts) {
    if (taskIds.has(attempt.taskId)) repeatedAttempts++;
    taskIds.add(attempt.taskId);
    if (attempt.inputTokens !== undefined && attempt.outputTokens !== undefined) {
      tokenTotal += attempt.inputTokens + attempt.outputTokens;
      tokenSamples++;
    }
    if (attempt.latencyMs !== undefined) {
      latencyTotal += attempt.latencyMs;
      latencySamples++;
    }
  }
  return {
    attempts: attempts.length,
    passed: attempts.filter((attempt) => attempt.passed).length,
    repeatedAttempts,
    tokenTotal: tokenSamples ? tokenTotal : undefined,
    tokenSamples,
    averageLatencyMs: latencySamples ? latencyTotal / latencySamples : undefined,
    latencySamples,
  };
}

export function realModelAttempts(attempts: HistoryAttempt[], model: Model): HistoryAttempt[] {
  return attempts.filter((attempt) => !attempt.simulated && attemptKey(attempt) === modelKey(model));
}

export function formatTokens(summary: EvidenceSummary): string {
  return summary.tokenTotal === undefined ? "Unknown" : `${summary.tokenTotal.toLocaleString()} (${summary.tokenSamples}/${summary.attempts} recorded)`;
}

export function formatLatency(summary: EvidenceSummary): string {
  return summary.averageLatencyMs === undefined ? "Unknown" : `${(summary.averageLatencyMs / 1000).toFixed(1)}s (${summary.latencySamples}/${summary.attempts} recorded)`;
}
