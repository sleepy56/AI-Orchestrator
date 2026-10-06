import { Route, TaskSpec } from "./types";

export function routeTask(task: TaskSpec): Route {
  if (task.risk === "critical" || task.difficulty === "extreme") {
    return { worker: "sol", effort: "xhigh", label: "sol-xhigh" };
  }
  if (task.risk === "high" || (task.difficulty === "hard" && (task.type === "refactor" || task.type === "analysis"))) {
    return { worker: "sol", effort: "high", label: "sol-high" };
  }

  if (task.risk === "medium" || task.type === "refactor" || task.type === "analysis") {
    return { worker: "sol", effort: "medium", label: "sol-medium" };
  }

  if (task.difficulty === "hard") return { worker: "luna", effort: "high", label: "luna-high" };
  if (task.difficulty === "moderate") return { worker: "luna", effort: "medium", label: "luna-medium" };

  return { worker: "luna", effort: "low", label: "luna-low" };
}

export function routeReason(task: TaskSpec): string {
  if (task.risk === "critical" || task.difficulty === "extreme") return "critical risk or extreme difficulty";
  if (task.risk === "high" || (task.difficulty === "hard" && (task.type === "refactor" || task.type === "analysis"))) return "high risk or hard refactor or analysis";
  if (task.risk === "medium" || task.type === "refactor" || task.type === "analysis") return "medium risk, refactor, or analysis";
  if (task.difficulty === "hard") return "hard difficulty";
  if (task.difficulty === "moderate") return "moderate difficulty";
  return "low risk and easy task";
}
