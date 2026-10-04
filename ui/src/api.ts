export type TaskStatus = "pending" | "ready" | "running" | "blocked" | "completed" | "failed";

export interface Task {
  spec: { id: string; description: string; dependsOn: string[]; type: string; difficulty: string; risk: string };
  status: "pending" | "running" | "completed" | "failed";
  displayStatus: TaskStatus;
  attempts: Attempt[];
  failureReason?: string;
}

export interface Attempt {
  attempt: number;
  route?: { label: string };
  validation: { passed: boolean; errors: string[] };
  response?: string;
  model?: string;
  checkCommand?: string;
}

export interface Model {
  alias: string;
  provider: string;
  model: string;
  tier: string;
  effort: string;
  enabled: boolean;
  weight: number;
}

export interface HistoryAttempt {
  kind: "attempt";
  at: string;
  taskId: string;
  taskType: string;
  difficulty: string;
  risk: string;
  route: string;
  model?: string;
  passed: boolean;
  errors: string[];
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  checkCommand?: string;
  simulated: boolean;
}

export interface Run {
  runId: string;
  mode: "simulated" | "live";
  startedAt: string;
  finishedAt?: string;
  lastSequence: number;
  status: "running" | "finished";
}

export interface RunEvent {
  runId: string;
  sequence: number;
  at: string;
  type: string;
  taskId?: string;
  status?: string;
  reason?: string;
  chosenAlias?: string;
  chosenModel?: string;
  policyVersion?: number;
  preferenceWeight?: number;
  candidates?: Array<{ alias: string; model: string; weight: number }>;
  route?: { label: string };
  attempt?: Attempt | number;
  simulated?: boolean;
  blocked?: string[];
  mode?: "simulated" | "live";
  tasks?: Array<Omit<Task, "displayStatus">>;
  failureReason?: string;
}

export interface OverviewData {
  tasks: Task[];
  models: Model[];
  policyVersion: number;
  attempts: HistoryAttempt[];
  runs: Run[];
  selectedRun?: Run;
  events: RunEvent[];
}

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`API returned ${response.status} for ${path}`);
  return response.json() as Promise<T>;
}

export async function loadOverview(signal: AbortSignal, runId?: string): Promise<OverviewData> {
  const [taskResult, modelResult, runResult, historyResult] = await Promise.all([
    get<{ tasks: Task[] }>("/api/tasks", signal),
    get<{ models: Model[]; policyVersion?: number }>("/api/models", signal),
    get<{ runs: Run[] }>("/api/runs", signal),
    get<{ attempts: HistoryAttempt[] }>("/api/history", signal),
  ]);
  const selectedRun = runResult.runs.find((run) => run.runId === runId) ?? runResult.runs.find((run) => run.status === "running") ?? runResult.runs[0];
  const events: RunEvent[] = [];
  if (selectedRun) {
    let after = 0;
    while (after < selectedRun.lastSequence) {
      const page = await get<{ events: RunEvent[] }>(`/api/runs/${selectedRun.runId}/events?after=${after}`, signal);
      if (page.events.length === 0) break;
      events.push(...page.events);
      after = page.events[page.events.length - 1].sequence;
    }
  }
  return { tasks: taskResult.tasks, models: modelResult.models, policyVersion: modelResult.policyVersion ?? 1, attempts: historyResult.attempts, runs: runResult.runs, selectedRun, events };
}
