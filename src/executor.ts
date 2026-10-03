import { ExecutionResult, Route, TaskSpec } from "./types";

export interface Executor {
  execute(task: TaskSpec, route: Route, attempt: number): Promise<ExecutionResult>;
}

export type FakeOutcome = "pass" | "fail" | "invalid";

export class FakeExecutor implements Executor {
  readonly calls: Array<{ taskId: string; route: string; attempt: number }> = [];

  constructor(private readonly outcomes: Record<string, FakeOutcome[]> = {}) {}

  async execute(task: TaskSpec, route: Route, attempt: number): Promise<ExecutionResult> {
    this.calls.push({ taskId: task.id, route: route.label, attempt });
    const outcome = this.outcomes[task.id]?.[attempt - 1] ?? "pass";

    return {
      taskId: task.id,
      route,
      attempt,
      succeeded: outcome !== "fail",
      output: outcome === "pass" ? `Simulated completion: ${task.description}` : "",
      ...(outcome === "fail" ? { error: "Fake worker failed" } : {}),
    };
  }
}
