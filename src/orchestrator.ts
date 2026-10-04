import { nextRoute } from "./escalation";
import { Executor } from "./executor";
import { ProviderConfigurationError } from "./providers";
import { routeTask } from "./router";
import { RunEventData } from "./run-events";
import { TaskGraph } from "./scheduler";
import { AttemptRecord, Route, TaskSnapshot, TaskSpec } from "./types";
import { validate } from "./validator";

export interface RunResult {
  batches: string[][];
  snapshot: TaskSnapshot;
  blocked: string[];
}

export interface RunOptions {
  maxTasks?: number;
  onEvent?: (event: RunEventData) => Promise<void> | void;
  simulated?: boolean;
  routeDecision?: (task: TaskSpec, route: Route, attempt: number) => RunEventData;
}

export async function orchestrate(
  graph: TaskGraph,
  executor: Executor,
  onUpdate?: (snapshot: TaskSnapshot) => Promise<void> | void,
  options: RunOptions = {},
): Promise<RunResult> {
  const batches: string[][] = [];
  let executed = 0;
  if (options.maxTasks !== undefined && (!Number.isInteger(options.maxTasks) || options.maxTasks < 1)) {
    throw new Error("maxTasks must be a positive integer");
  }

  while (executed < (options.maxTasks ?? Number.POSITIVE_INFINITY)) {
    const ready = graph.ready().slice(0, (options.maxTasks ?? Number.POSITIVE_INFINITY) - executed);
    if (ready.length === 0) break;
    batches.push(ready.map((task) => task.id));
    if (executor.parallel === false) {
      // Live agents share a working tree; publish each transition for status readers.
      for (const task of ready) {
        graph.markRunning(task.id);
        await options.onEvent?.({ type: "task.started", taskId: task.id });
        await onUpdate?.(graph.snapshot());
        const result = await runTask(task, executor, graph.get(task.id).attempts.length, options.onEvent, options.simulated ?? false, options.routeDecision);
        graph.finish(result.id, result.attempts, result.passed);
        await options.onEvent?.({ type: "task.finished", taskId: task.id, status: result.passed ? "completed" : "failed", ...(!result.passed ? { failureReason: graph.get(task.id).failureReason } : {}) });
        await onUpdate?.(graph.snapshot());
        executed += 1;
      }
    } else {
      for (const task of ready) {
        graph.markRunning(task.id);
        await options.onEvent?.({ type: "task.started", taskId: task.id });
      }
      await onUpdate?.(graph.snapshot());
      const results = await Promise.all(ready.map((task) => runTask(task, executor, graph.get(task.id).attempts.length, options.onEvent, options.simulated ?? false, options.routeDecision)));
      for (const result of results) {
        graph.finish(result.id, result.attempts, result.passed);
        await options.onEvent?.({ type: "task.finished", taskId: result.id, status: result.passed ? "completed" : "failed", ...(!result.passed ? { failureReason: graph.get(result.id).failureReason } : {}) });
      }
      await onUpdate?.(graph.snapshot());
      executed += ready.length;
    }
  }

  return {
    batches,
    snapshot: graph.snapshot(),
    blocked: graph.blocked().map((task) => task.id),
  };
}

async function runTask(
  task: TaskSpec,
  executor: Executor,
  attemptOffset = 0,
  onEvent?: (event: RunEventData) => Promise<void> | void,
  simulated = false,
  routeDecision?: (task: TaskSpec, route: Route, attempt: number) => RunEventData,
): Promise<{ id: string; attempts: AttemptRecord[]; passed: boolean }> {
  const attempts: AttemptRecord[] = [];
  const initial = routeTask(task);
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
    });
    await onEvent?.({ type: "attempt.finished", taskId: task.id, attempt: attempts[attempts.length - 1], simulated });
    if (validation.passed) return { id: task.id, attempts, passed: true };
    if (fatal || execution?.retryable === false) return { id: task.id, attempts, passed: false };
    const escalation = nextRoute(initial, attempts.length);
    if (!escalation) return { id: task.id, attempts, passed: false };
    route = escalation;
  }
}
