export type TaskType = "rename" | "refactor" | "analysis" | "test" | "other";
export type Difficulty = "easy" | "moderate" | "hard" | "extreme";
export type Risk = "low" | "medium" | "high" | "critical";

export interface TaskSpec {
  id: string;
  description: string;
  type: TaskType;
  difficulty: Difficulty;
  risk: Risk;
  dependsOn: string[];
}

export type Worker = "luna" | "sol";
export type Effort = "low" | "medium" | "high" | "xhigh";

export interface Route {
  worker: Worker;
  effort: Effort;
  label: `${Worker}-${Effort}`;
}

export interface ExecutionResult {
  taskId: string;
  route: Route;
  attempt: number;
  succeeded: boolean;
  output: string;
  error?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  checkCommand?: string;
  retryable?: boolean;
}

export interface ValidationResult {
  passed: boolean;
  errors: string[];
}

export interface AttemptRecord {
  attempt: number;
  route: Route;
  validation: ValidationResult;
  response?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  checkCommand?: string;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed";
export type ScheduledStatus = TaskStatus | "ready" | "blocked";

export interface TaskRecord {
  spec: TaskSpec;
  status: TaskStatus;
  attempts: AttemptRecord[];
  failureReason?: string;
}

export interface TaskSnapshot {
  tasks: TaskRecord[];
}
