import { nextRoute } from "./escalation";
import { Executor } from "./executor";
import { ProviderConfigurationError } from "./providers";
import { routeTask } from "./router";
import { TaskGraph } from "./scheduler";
import { AttemptRecord, TaskSnapshot, TaskSpec } from "./types";
import { validate } from "./validator";

export interface RunResult {
  batches: string[][];
  snapshot: TaskSnapshot;
  blocked: string[];
}

export async function orchestrate(
  graph: TaskGraph,
  executor: Executor,
  onUpdate?: (snapshot: TaskSnapshot) => Promise<void> | void,
): Promise<RunResult> {
  const batches: string[][] = [];

  while (true) {
    const ready = graph.ready();
    if (ready.length === 0) break;
    batches.push(ready.map((task) => task.id));
    if (executor.parallel === false) {
      // Live agents share a working tree; publish each transition for status readers.
      for (const task of ready) {
        graph.markRunning(task.id);
        await onUpdate?.(graph.snapshot());
        const result = await runTask(task, executor, graph.get(task.id).attempts.length);
        graph.finish(result.id, result.attempts, result.passed);
        await onUpdate?.(graph.snapshot());
      }
    } else {
      for (const task of ready) graph.markRunning(task.id);
      const results = await Promise.all(ready.map((task) => runTask(task, executor, graph.get(task.id).attempts.length)));
      for (const result of results) graph.finish(result.id, result.attempts, result.passed);
      await onUpdate?.(graph.snapshot());
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
): Promise<{ id: string; attempts: AttemptRecord[]; passed: boolean }> {
  const attempts: AttemptRecord[] = [];
  const initial = routeTask(task);
  let route = initial;

  while (true) {
    const attempt = attemptOffset + attempts.length + 1;
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
      ...(execution?.model ? { model: execution.model } : {}),
      ...(execution?.inputTokens !== undefined ? { inputTokens: execution.inputTokens } : {}),
      ...(execution?.outputTokens !== undefined ? { outputTokens: execution.outputTokens } : {}),
      ...(execution?.latencyMs !== undefined ? { latencyMs: execution.latencyMs } : {}),
      ...(execution?.checkCommand ? { checkCommand: execution.checkCommand } : {}),
    });
    if (validation.passed) return { id: task.id, attempts, passed: true };
    if (fatal || execution?.retryable === false) return { id: task.id, attempts, passed: false };
    const escalation = nextRoute(initial, attempts.length);
    if (!escalation) return { id: task.id, attempts, passed: false };
    route = escalation;
  }
}
