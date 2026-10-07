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
  status: "running" | "paused" | "finished";
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
  lessonIds?: string[];
  selections?: LessonSelection[];
}

export interface LessonSelection { id: string; scope: "project" | "global"; reason: string }
export interface Lesson { id: string; scope: "project" | "global"; text: string; taskCategory: string; reviewStatus: string; sourceRunId: string | null }
export interface Candidate { id: string; text: string; taskCategory: string; reviewStatus: string; evidence: Array<{ attemptId: string; runId: string; taskId: string }> }
export interface KnowledgeData {
  lessons: Lesson[];
  notes?: Lesson[];
  candidates: Candidate[];
  retrieval: Array<{ taskId: string; selections: LessonSelection[] }>;
  usedInRuns: Array<{ runId: string; taskId: string; at: string; mode: "live" | "simulated"; lessonIds: string[]; selections: LessonSelection[] }>;
}
export interface RouteEvidence { taskCount: number; attemptCount: number; validatedPasses: number; retries: number; passRate95: [number, number]; averageInputTokens: number; averageOutputTokens: number; averageLatencyMs: number; averageCostPerTask: number; evidenceIds: string[]; alias: string }
export interface RouteProposal { chosenAlias: string; fallbackAlias: string; recommendedAlias?: string; reason: string; uncertainty: string; priceVersion?: string; currency?: string; baseline?: RouteEvidence; candidate?: RouteEvidence }
export interface ProposalData { priceVersion?: string; proposals: Array<{ taskId: string; proposal: RouteProposal }> }

export interface OverviewData {
  tasks: Task[];
  models: Model[];
  policyVersion: number;
  attempts: HistoryAttempt[];
  runs: Run[];
  selectedRun?: Run;
  events: RunEvent[];
  knowledge: KnowledgeData;
  proposals: ProposalData;
}

export interface ProjectRecord { id: string; directory: string; git?: { isRepository: boolean; branch?: string; head?: string; dirty?: boolean }; scripts?: Record<string, string>; context?: { version: number; documents: string[] } }
export type ProjectData = { registered: true; project: { revision: number; value: ProjectRecord } } | { registered: false; directory: string };
export async function loadProject(signal: AbortSignal): Promise<ProjectData> { return get<ProjectData>("/api/project", signal); }
export async function registerProject(documents: string[]): Promise<ProjectRecord & { revision: number }> {
  const response = await fetch("/api/project/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documents }) });
  const body = await response.json() as ProjectRecord & { revision: number; error?: string };
  if (!response.ok) throw new Error(body.error ?? `API returned ${response.status}`);
  return body;
}

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`API returned ${response.status} for ${path}`);
  return response.json() as Promise<T>;
}

export interface LocalCommand { version: 1; kind: "project.update" | "project.register" | "plan.add" | "plan.retry" | "plan.goal" | "plan.answer" | "plan.draft" | "check.put" | "check.result" | "action.request" | "approval.grant" | "run.record" | "policy.put" | "policy.model" | "policy.limits" | "policy.route" | "policy.rollback" | "worktree.base"; expectedRevision: number; payload: Record<string, unknown> }
export interface LocalCommandResult { revision: number; auditId: string; subjectId: string }

export async function applyLocalCommand(command: LocalCommand, signal?: AbortSignal): Promise<LocalCommandResult> {
  const response = await fetch("/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), signal });
  if (!response.ok) {
    const body = await response.json() as { error?: string };
    throw new Error(body.error ?? `API returned ${response.status} for /api/commands`);
  }
  return response.json() as Promise<LocalCommandResult>;
}
export interface DraftTask { id: string; description: string; type: string; difficulty: string; risk: string; dependsOn: string[]; acceptanceCriteria: string[]; areas: string[]; workerProfile: string; context: string[]; verification: string[]; testArtifacts?: Array<{ name: string; content: string }> }
export interface PlanningState { revision: number; plan: { revision: number; value: { draft?: { goal: string; status: "clarifying" | "review"; questions: Array<{ id: string; question: string; impact: string }>; answers: Record<string, string>; tasks: DraftTask[] } } }; checksRevision?: number; approvals: Record<string, { value: { target: string; targetRevision: number; actionId?: string } }>; actions?: Record<string, { revision: number; value: { target: "merge" | "deployment"; destination: string; artifactRevision: string; baseRevision?: string; planRevision: number; checksRevision: number } }>; runs?: Record<string, { value: { status: string; mode: string; reason?: string } }> }
export interface CheckRow { id: string; taskId?: string; criterion?: string; phase: string; source?: string; command?: string; procedure?: string; expected: string; revision: number; status: "pass" | "fail" | "skipped" | "missing" | "unrun"; result?: { at: string; reason?: string; reviewer?: string; output?: string }; history?: Array<{ revision: number; command?: string; procedure?: string; phase: string; timeoutSeconds: number; expected: string; results: Array<{ at: string; status: string; reason?: string; reviewer?: string }> }> }
export interface CheckReport { rows: CheckRow[]; counts: Record<CheckRow["status"], number> }
export async function loadChecks(): Promise<CheckReport> { return get<CheckReport>("/api/checks", new AbortController().signal); }
export async function checkAction(action: "baseline" | "run", id?: string): Promise<unknown> {
  const response = await fetch(`/api/checks/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(id ? { id } : {}) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `API returned ${response.status}`);
  return result;
}
export async function loadPlanning(signal?: AbortSignal): Promise<PlanningState> { return get<PlanningState>("/api/commands", signal ?? new AbortController().signal); }
export async function requestPlanning(action: "start" | "answer", body: Record<string, unknown>): Promise<LocalCommandResult> {
  const response = await fetch(`/api/planning/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as LocalCommandResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `API returned ${response.status}`);
  return result;
}

export interface WorkflowData {
  revision: number;
  base: { branch: string; commit: string } | null;
  capacity: { availability: "known" | "unknown"; signal?: { observedAt: string; remainingTokens?: number; resetAt?: string; retryAfter?: string; maxConcurrent?: number } };
  worktrees: {
    workers: Record<string, { branch: string; path: string; base: string; commit?: string; validation?: { passed: boolean; command: string; output: string } }>;
    integrations: Record<string, { id: string; taskIds: string[]; target: string; base: string; path: string; diff: string; conflicts: string[]; commit?: string; actionId?: string; merged?: boolean; check?: { command: string; passed: boolean; output: string } }>;
  };
  policy: { version: number; routing: { limits: { allowedProviders?: string[]; blockedModels?: string[]; maxCostPerTaskUsd?: number }; rules: Record<string, { alias: string; fallbackAlias: string }> }; history: Array<{ version: number; at: string; author: string; cause: string; reason: string; before: unknown; after: unknown; evidenceIds: string[]; priceVersion?: string; currency?: string; baseline?: RouteEvidence; candidate?: RouteEvidence; rollbackTo: number }> };
  runs: Record<string, { value: { status: string; mode: string; reason?: string } }>;
  jobs?: Array<{ id: string; startedAt: string; status: "running" | "finished" | "failed"; output: string; errorOutput: string; exitCode?: number | null }>;
}
export async function loadWorkflow(signal?: AbortSignal): Promise<WorkflowData> { return get<WorkflowData>("/api/workflow", signal ?? new AbortController().signal); }
export async function workflowAction(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("/api/workflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `API returned ${response.status}`);
  return result;
}
export async function knowledgeAction(body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/knowledge/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) { const result = await response.json() as { error?: string }; throw new Error(result.error ?? `API returned ${response.status}`); }
}

export async function loadOverview(signal: AbortSignal, runId?: string): Promise<OverviewData> {
  const [taskResult, modelResult, runResult, historyResult, knowledge, proposals] = await Promise.all([
    get<{ tasks: Task[] }>("/api/tasks", signal),
    get<{ models: Model[]; policyVersion?: number }>("/api/models", signal),
    get<{ runs: Run[] }>("/api/runs", signal),
    get<{ attempts: HistoryAttempt[] }>("/api/history", signal),
    get<KnowledgeData>("/api/knowledge", signal),
    get<ProposalData>("/api/model-proposals", signal),
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
  return { tasks: taskResult.tasks, models: modelResult.models, policyVersion: modelResult.policyVersion ?? 1, attempts: historyResult.attempts, runs: runResult.runs, selectedRun, events, knowledge, proposals };
}
