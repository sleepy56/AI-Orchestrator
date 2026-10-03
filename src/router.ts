import { Route, TaskSpec } from "./types";

export function routeTask(task: TaskSpec): Route {
  if (task.risk === "high" || task.difficulty === "hard") {
    return { worker: "sol", effort: "high", label: "sol-high" };
  }

  if (
    task.risk === "medium" ||
    task.difficulty === "moderate" ||
    task.type === "refactor" ||
    task.type === "analysis"
  ) {
    return { worker: "sol", effort: "medium", label: "sol-medium" };
  }

  return { worker: "luna", effort: "low", label: "luna-low" };
}
