import { nextRoute } from "./escalation";
import { Executor } from "./executor";
import { ProviderConfigurationError } from "./providers";
import { routeTask } from "./router";
import { RunEventData } from "./run-events";
import { TaskGraph } from "./scheduler";
import { AttemptRecord, Route, TaskSnapshot, TaskSpec } from "./types";
import { validate } from "./validator";
import { CapacityDecision } from "./capacity";

export interface RunResult {
  batches: string[][];
  snapshot: TaskSnapshot;
  blocked: string[];
  paused?: string;
}

export interface RunOptions {
  maxTasks?: number;
  onEvent?: (event: RunEventData) => Promise<void> | void;
  simulated?: boolean;
  routeDecision?: (task: TaskSpec, route: Route, attempt: number) => RunEventData;
  initialRoute?: (task: TaskSpec) => Route;
  retryRoute?: (task: TaskSpec, initial: Route, failedAttempts: number) => Route | null;
  beforeTask?: () => Promise<string | undefined> | string | undefined;
  capacity?: (task: TaskSpec, inFlight: TaskSpec[]) => Promise<CapacityDecision>;
}

export async function orchestrate(
  graph: TaskGraph,
  executor: Executor,
  onUpdate?: (snapshot: TaskSnapshot) => Promise<void> | void,
  options: RunOptions = {},
): Promise<RunResult> {
  const batches: string[][] = [];
  let executed = 0;
  let paused: string | undefined;
  if (options.maxTasks !== undefined && (!Number.isInteger(options.maxTasks) || options.maxTasks < 1)) {
    throw new Error("maxTasks must be a positive integer");
  }

  while (executed < (options.maxTasks ?? Number.POSITIVE_INFINITY)) {
    const ready = graph.ready().slice(0, (options.maxTasks ?? Number.POSITIVE_INFINITY) - executed);
    if (ready.length === 0) break;
    const wave: TaskSpec[] = [];
    for (const task of ready) {
      paused = await options.beforeTask?.();
      if (paused) break;
      const decision = await options.capacity?.(task, wave);
      if (decision?.reason) { paused = decision.reason; break; }
      const limit = executor.parallel === false ? 1 : decision?.limit ?? Number.POSITIVE_INFINITY;
      if (wave.length >= limit) break;
      wave.push(task);
      graph.markRunning(task.id);
      await options.onEvent?.({ type: "task.started", taskId: task.id });
      await onUpdate?.(graph.snapshot());
    }
    if (!wave.length) break;
    batches.push(wave.map((task) => task.id));
    const results = await Promise.all(wave.map((task) => runTask(task, executor, graph.get(task.id).attempts.length, options.onEvent, options.simulated ?? false, options.routeDecision, options.initialRoute, options.retryRoute)));
    for (const result of results) {
      if (result.pausedReason) {
        graph.defer(result.id, result.attempts);
        paused = result.pausedReason;
        await onUpdate?.(graph.snapshot());
        continue;
      }
      graph.finish(result.id, result.attempts, result.passed);
      await options.onEvent?.({ type: "task.finished", taskId: result.id, status: result.passed ? "completed" : "failed", ...(!result.passed ? { failureReason: graph.get(result.id).failureReason } : {}) });
      await onUpdate?.(graph.snapshot());
    }
    executed += wave.length;
    if (paused) break;
  }

  return {
    batches,
    snapshot: graph.snapshot(),
    blocked: graph.blocked().map((task) => task.id),
    ...(paused ? { paused } : {}),
  };
}

async function runTask(
  task: TaskSpec,
  executor: Executor,
  attemptOffset = 0,
  onEvent?: (event: RunEventData) => Promise<void> | void,
  simulated = false,
  routeDecision?: (task: TaskSpec, route: Route, attempt: number) => RunEventData,
  initialRoute?: (task: TaskSpec) => Route,
  retryRoute?: (task: TaskSpec, initial: Route, failedAttempts: number) => Route | null,
): Promise<{ id: string; attempts: AttemptRecord[]; passed: boolean; pausedReason?: string }> {
  const attempts: AttemptRecord[] = [];
  const initial = initialRoute?.(task) ?? routeTask(task);
  let route = initial;

  while (true) {
    const attempt = attemptOffset + attempts.length + 1;
    if (routeDecision) await onEvent?.(routeDecision(task, route, attempt));
    await onEvent?.({ type: "attempt.started", taskId: task.id, attempt, route });
    let validation;
    let execution;
    let fatal = false;
    try {
      execution = await executor.execute(task, route, attempt);
      validation = validate(task, execution);
    } catch (error) {
      fatal = error instanceof ProviderConfigurationError;
      validation = {
        passed: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }

    attempts.push({
      attempt, route, validation,
      ...(execution?.output ? { response: execution.output } : {}),
      ...(execution?.model ? { model: execution.model } : {}),
      ...(execution?.inputTokens !== undefined ? { inputTokens: execution.inputTokens } : {}),
      ...(execution?.outputTokens !== undefined ? { outputTokens: execution.outputTokens } : {}),
      ...(execution?.latencyMs !== undefined ? { latencyMs: execution.latencyMs } : {}),
      ...(execution?.checkCommand ? { checkCommand: execution.checkCommand } : {}),
      ...(execution?.checkOutput !== undefined ? { checkOutput: execution.checkOutput } : {}),
      ...(execution?.checkExitCode !== undefined ? { checkExitCode: execution.checkExitCode } : {}),
      ...(execution?.contextId ? { contextId: execution.contextId } : {}),
      ...(execution?.worktree ? { worktree: execution.worktree } : {}),
      ...(execution?.commit ? { commit: execution.commit } : {}),
    });
    await onEvent?.({ type: "attempt.finished", taskId: task.id, attempt: attempts[attempts.length - 1], simulated });
    if (execution?.capacityReason) return { id: task.id, attempts, passed: false, pausedReason: execution.capacityReason };
    if (validation.passed) return { id: task.id, attempts, passed: true };
    if (fatal || execution?.retryable === false) return { id: task.id, attempts, passed: false };
    const escalation = retryRoute?.(task, initial, attempts.length) ?? (retryRoute ? null : nextRoute(initial, attempts.length));
    if (!escalation) return { id: task.id, attempts, passed: false };
    route = escalation;
  }
}
