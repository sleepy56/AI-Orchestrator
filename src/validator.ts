import { ExecutionResult, TaskSpec, ValidationResult } from "./types";

export function validate(task: TaskSpec, result: ExecutionResult): ValidationResult {
  const errors: string[] = [];

  if (result.taskId !== task.id) errors.push("Result belongs to a different task");
  if (!result.succeeded) errors.push(result.error ?? "Worker reported failure");
  if (!result.output.trim()) errors.push("Worker returned no output");

  return { passed: errors.length === 0, errors };
}
