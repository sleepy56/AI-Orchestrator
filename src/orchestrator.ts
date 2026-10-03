import { nextRoute } from "./escalation";
import { Executor } from "./executor";
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
    for (const task of ready) graph.markRunning(task.id);

    // Independent tasks in the same batch run concurrently.
    const results = await Promise.all(ready.map((task) => runTask(task, executor)));
    for (const result of results) graph.finish(result.id, result.attempts, result.passed);
    await onUpdate?.(graph.snapshot());
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
): Promise<{ id: string; attempts: AttemptRecord[]; passed: boolean }> {
  const attempts: AttemptRecord[] = [];
  const initial = routeTask(task);
  let route = initial;

  while (true) {
    const attempt = attempts.length + 1;
    let validation;
    try {
      const execution = await executor.execute(task, route, attempt);
      validation = validate(task, execution);
    } catch (error) {
      validation = {
        passed: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }

    attempts.push({ attempt, route, validation });
    if (validation.passed) return { id: task.id, attempts, passed: true };
    const escalation = nextRoute(initial, attempts.length);
    if (!escalation) return { id: task.id, attempts, passed: false };
    route = escalation;
  }
}
