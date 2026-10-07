import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TaskGraph } from "./scheduler";
import { defaultRegistry, loadRegistry, ModelProfile, saveRegistry, validateProfile } from "./models";
import { PriceSnapshot, recommendModelRoute } from "./model-decisions";
import { KnowledgeStore, AttemptEntry } from "./knowledge";
import { allowedProfile, emptyRouting, parseLimits, PolicyRevision, routeKey, RoutingState } from "./routing-policy";
import { Difficulty, Risk, TaskSnapshot, TaskSpec, TaskType } from "./types";

// This file is local state. Only sharedView() may be passed to a shared store.
export type CommandKind = "project.update" | "project.register" | "plan.add" | "plan.retry" | "plan.goal" | "plan.answer" | "plan.draft" | "check.put" | "check.result" | "action.request" | "approval.grant" | "run.record" | "policy.put" | "policy.model" | "policy.limits" | "policy.route" | "policy.rollback" | "worktree.base";
export interface PlanningQuestion { id: string; question: string; impact: string }
export interface DraftTask { id: string; description: string; type: TaskType; difficulty: Difficulty; risk: Risk; dependsOn: string[]; acceptanceCriteria: string[]; areas: string[]; workerProfile: string; context: string[]; verification: string[]; testArtifacts?: Array<{ name: string; content: string }> }
export interface PlanningDraft { goal: string; questions: PlanningQuestion[]; answers: Record<string, string>; tasks: DraftTask[]; status: "clarifying" | "review" }
export interface Command { version: 1; kind: CommandKind; expectedRevision: number; payload: Record<string, unknown> }
export interface AuditEvent { id: string; at: string; kind: CommandKind; revision: number; subjectId: string }
export interface CommandResult { revision: number; auditId: string; subjectId: string }
interface Versioned<T> { revision: number; value: T }
export type ActionTarget = "merge" | "deployment";
export interface ActionRequest { target: ActionTarget; destination: string; artifactRevision: string; baseRevision?: string; planRevision: number; checksRevision: number }
export interface Approval { target: "plan" | "checks" | ActionTarget; targetRevision: number; actor: string; actionId?: string; at: string }
export type CheckPhase = "baseline" | "task" | "integration" | "review";
export type CheckStatus = "pass" | "fail" | "skipped" | "missing";
export interface CheckValue { taskId?: string; criterion?: string; command?: string; procedure?: string; phase: CheckPhase; cwd: string; timeoutSeconds: number; expected: string; source: "generated" | "user" | "baseline"; planRevision?: number }
export interface CheckResult { at: string; checkRevision: number; status: CheckStatus; exitCode?: number | null; output?: string; durationMs?: number; reason?: string; reviewer?: string }
export interface CheckRecord extends Versioned<CheckValue> { history: Array<Versioned<CheckValue>>; results: CheckResult[] }
export interface ProjectRecord { id: string; directory: string; name?: string; git?: { isRepository: boolean; branch?: string; head?: string; dirty?: boolean }; scripts?: Record<string, string>; context?: { version: number; documents: string[] } }
interface LocalState {
  version: 1;
  revision: number;
  project: Versioned<ProjectRecord>;
  plan: Versioned<{ taskIds: string[]; draft?: PlanningDraft }>;
  checksRevision: number;
  checks: Record<string, CheckRecord>;
  approvals: Record<string, Versioned<Approval>>;
  actions: Record<string, Versioned<ActionRequest>>;
  runs: Record<string, Versioned<{ status: string; mode: string; planRevision?: number; checksRevision?: number; reason?: string }>>;
  worktreeBase?: { branch: string; commit: string; planRevision: number; checksRevision: number; contextVersion: number };
  policy: Versioned<{ rules: Record<string, unknown>; routing?: RoutingState; history?: PolicyRevision[] }>;
  audit: AuditEvent[];
}

export function hasApproval(state: Pick<LocalState, "approvals">, target: Approval["target"], revision: number, actionId?: string): boolean {
  return Object.values(state.approvals).some(({ value }) => value.target === target && value.targetRevision === revision && value.actionId === actionId);
}

export function executionGate(state: Pick<LocalState, "plan" | "checksRevision" | "approvals">): string | undefined {
  if (!state.plan.value.draft) return undefined; // Legacy single-task plans have no draft review workflow.
  if (state.plan.value.draft.status !== "review" || !hasApproval(state, "plan", state.plan.revision)) return `Plan revision ${state.plan.revision} awaits approval`;
  if (state.checksRevision < 1 || !hasApproval(state, "checks", state.checksRevision)) return `Checks revision ${state.checksRevision} awaits approval`;
  return undefined;
}

export function worktreeBaseGate(state: Pick<LocalState, "project" | "plan" | "checksRevision" | "approvals" | "worktreeBase">): string | undefined {
  const gate = executionGate(state);
  if (gate) return gate;
  const base = state.worktreeBase;
  if (!base || base.planRevision !== state.plan.revision || base.checksRevision !== state.checksRevision ||
    base.contextVersion !== (state.project.value.context?.version ?? 0)) return "An approved worktree base is required for the current plan, checks, and document manifest";
  return undefined;
}

export function actionGate(state: Pick<LocalState, "plan" | "checksRevision" | "approvals" | "actions">, id: string): string | undefined {
  const action = state.actions[id];
  if (!action) throw new Error(`Unknown action: ${id}`);
  if (action.value.planRevision !== state.plan.revision || action.value.checksRevision !== state.checksRevision) return "Plan or checks changed after the action request";
  const prerequisite = executionGate(state);
  if (prerequisite) return prerequisite;
  return hasApproval(state, action.value.target, action.revision, id) ? undefined : `${action.value.target} request ${id} revision ${action.revision} awaits approval`;
}

const types: TaskType[] = ["rename", "refactor", "analysis", "test", "other"];
const difficulties: Difficulty[] = ["easy", "moderate", "hard", "extreme"];
const risks: Risk[] = ["low", "medium", "high", "critical"];

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} needs a nonempty string`);
  return value;
}
function choice<T extends string>(value: unknown, values: T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Invalid ${name}: ${String(value)}`);
  return value as T;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} needs an object`);
  return value as Record<string, unknown>;
}
function safeId(value: unknown, name: string): string {
  const id = string(value, name);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid ${name}`);
  return id;
}
function opaqueId(value: unknown, name: string): string {
  const id = string(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error(`Invalid ${name}`);
  return id;
}
function validRevision(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name}`);
  return value as number;
}
function checkValue(payload: Record<string, unknown>, source: CheckValue["source"]): CheckValue {
  const phase = choice(payload.phase, ["baseline", "task", "integration", "review"], "check phase");
  const timeout = payload.timeoutSeconds;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 3600) throw new Error("Invalid check timeoutSeconds");
  const command = payload.command === undefined ? undefined : string(payload.command, "check command");
  const procedure = payload.procedure === undefined ? undefined : string(payload.procedure, "review procedure");
  if (Boolean(command) === Boolean(procedure)) throw new Error("Check needs exactly one command or review procedure");
  if (phase === "review" && !procedure || phase !== "review" && !command) throw new Error("Review checks need a procedure; executable checks need a command");
  if ((phase === "task" || phase === "review") && payload.taskId === undefined) throw new Error("Task and review checks need a taskId");
  if (phase === "baseline" && payload.taskId !== undefined) throw new Error("Baseline checks belong to the project");
  const cwd = payload.cwd === undefined ? "." : string(payload.cwd, "check cwd");
  if (isAbsolute(cwd) || /^[a-zA-Z]:/.test(cwd) || cwd.split(/[\\/]/).includes("..")) throw new Error("Check cwd must stay within the project");
  return { taskId: payload.taskId === undefined ? undefined : safeId(payload.taskId, "taskId"),
    criterion: payload.criterion === undefined ? undefined : string(payload.criterion, "criterion"), command, procedure, phase,
    cwd, timeoutSeconds: timeout as number, expected: string(payload.expected, "check expected"), source };
}
function generatedChecks(state: LocalState): void {
  const draft = state.plan.value.draft;
  if (!draft || draft.status !== "review") return;
  // The reviewed check set has its own revision even when suggestions produced no runnable checks.
  state.checksRevision++;
  for (const task of draft.tasks) task.acceptanceCriteria.forEach((criterion, index) => {
    const verification = task.verification[index];
    let command = /^command:\s*(.+)$/i.exec(verification)?.[1]?.trim();
    if (command) command = command.replace(/\{\{test:([^}]+)\}\}/g, (_whole, name: string) =>
      task.testArtifacts?.some((artifact) => artifact.name === name) ? `.orch/generated-tests/plan-r${state.plan.revision}/${task.id}/${name}` : "");
    const review = /^review:\s*(.+)$/i.exec(verification)?.[1]?.trim();
    if (!command && !review) return; // An unstructured suggestion is missing evidence, not a passed review.
    const id = randomUUID();
    const value: CheckValue = { taskId: task.id, criterion, phase: command ? "task" : "review", cwd: ".", timeoutSeconds: 600,
      expected: command ? `Exit 0 and evidence for: ${criterion}` : `Named reviewer confirms: ${criterion}`,
      ...(command ? { command } : { procedure: review }), source: "generated", planRevision: state.plan.revision };
    state.checks[id] = { revision: 1, value, history: [{ revision: 1, value }], results: [] };
    state.checksRevision++;
  });
}
function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} needs ${minimum ? "nonempty " : ""}strings`);
  return value as string[];
}
function questions(value: unknown): PlanningQuestion[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("Planning accepts at most three questions");
  const parsed = value.map((item) => { const entry = object(item, "question"); return { id: safeId(entry.id, "question id"), question: string(entry.question, "question"), impact: string(entry.impact, "question impact") }; });
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) throw new Error("Duplicate question ID");
  return parsed;
}
function draftTasks(value: unknown): DraftTask[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Draft needs tasks");
  const tasks = value.map((item) => {
    const entry = object(item, "draft task");
    const dependsOn = strings(entry.dependsOn, "dependencies");
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error("Duplicate draft dependency");
    const acceptanceCriteria = strings(entry.acceptanceCriteria, "acceptance criteria", 1);
    const verification = strings(entry.verification, "verification", 1);
    if (verification.length !== acceptanceCriteria.length) throw new Error("Give one verification entry per acceptance criterion");
    const testArtifacts = entry.testArtifacts === undefined ? undefined : (() => {
      if (!Array.isArray(entry.testArtifacts)) throw new Error("testArtifacts needs an array");
      const artifacts = entry.testArtifacts.map((item) => {
        const artifact = object(item, "test artifact");
        const name = string(artifact.name, "test artifact name");
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name) || name.includes("..")) throw new Error("Invalid test artifact name");
        const content = string(artifact.content, "test artifact content");
        if (content.length > 100_000) throw new Error("Test artifact is too large");
        return { name, content };
      });
      if (new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length) throw new Error("Duplicate test artifact name");
      return artifacts;
    })();
    for (const item of verification) for (const match of item.matchAll(/\{\{test:([^}]+)\}\}/g)) {
      if (!testArtifacts?.some((artifact) => artifact.name === match[1])) throw new Error(`Missing generated test artifact: ${match[1]}`);
    }
    return { id: safeId(entry.id, "task id"), description: string(entry.description, "description"),
      type: choice(entry.type, types, "type"), difficulty: choice(entry.difficulty, difficulties, "difficulty"), risk: choice(entry.risk, risks, "risk"),
      dependsOn, acceptanceCriteria,
      areas: strings(entry.areas, "areas", 1), workerProfile: string(entry.workerProfile, "worker profile"),
      context: strings(entry.context, "context", 1), verification, ...(testArtifacts ? { testArtifacts } : {}) };
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("Duplicate draft task ID");
  new TaskGraph({ tasks: tasks.map(({ acceptanceCriteria, areas, workerProfile, context, verification, testArtifacts, ...spec }) => ({ spec, status: "pending", attempts: [] })) });
  return tasks;
}
function nextTaskId(snapshot: TaskSnapshot): string {
  const ids = new Set(snapshot.tasks.map((task) => task.spec.id));
  let number = Math.max(0, ...snapshot.tasks.map((task) => Number(/^TASK-(\d+)$/.exec(task.spec.id)?.[1] ?? 0))) + 1;
  while (ids.has(`TASK-${String(number).padStart(3, "0")}`)) number++;
  return `TASK-${String(number).padStart(3, "0")}`;
}
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
const execFileAsync = promisify(execFile);
async function discover(directory: string): Promise<Pick<ProjectRecord, "git" | "scripts">> {
  const git = { isRepository: false } as NonNullable<ProjectRecord["git"]>;
  const runGit = async (...args: string[]) => (await execFileAsync("git", ["-c", `safe.directory=${directory.replace(/\\/g, "/")}`, "-C", directory, ...args], { timeout: 5000, windowsHide: true })).stdout.trim();
  try {
    const root = await runGit("rev-parse", "--show-toplevel");
    if (resolve(root) === directory) {
      git.isRepository = true;
      git.branch = await runGit("branch", "--show-current");
      git.head = await runGit("rev-parse", "HEAD").catch(() => undefined);
      git.dirty = Boolean(await runGit("status", "--porcelain"));
    }
  } catch { /* Legacy orch projects may not use Git. */ }
  let scripts: Record<string, string> = {};
  try {
    const packageFile = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { scripts?: unknown };
    if (packageFile.scripts && typeof packageFile.scripts === "object" && !Array.isArray(packageFile.scripts)) {
      scripts = Object.fromEntries(Object.entries(packageFile.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  } catch (error) { if (!missing(error)) throw error; }
  return { git, scripts };
}
async function documentsIn(directory: string, input: unknown): Promise<string[]> {
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) throw new Error("documents needs an array of repository-relative file paths");
  const root = await realpath(directory);
  const documents: string[] = [];
  for (const item of input as string[]) {
    if (!item || isAbsolute(item) || /^[a-zA-Z]:/.test(item)) throw new Error("Context documents must be repository-relative files");
    const file = await realpath(resolve(directory, item));
    const path = relative(root, file);
    if (!path || path === ".." || path.startsWith(`..\\`) || path.startsWith("../") || isAbsolute(path) || !(await stat(file)).isFile()) throw new Error("Context document escapes the repository or is not a file");
    documents.push(path.replace(/\\/g, "/"));
  }
  if (new Set(documents).size !== documents.length) throw new Error("Duplicate context document");
  return documents;
}

export class CommandService {
  private readonly directory: string;
  constructor(project: string) { this.directory = resolve(project); }
  private get path(): string { return join(this.directory, ".orch", "commands.v1.json"); }
  private get tasksPath(): string { return join(this.directory, ".orch", "tasks.json"); }

  private async verifyMergeBase(action: ActionRequest): Promise<void> {
    if (action.target !== "merge") return;
    let head: string;
    try {
      head = (await execFileAsync("git", ["-c", `safe.directory=${this.directory.replace(/\\/g, "/")}`, "-C", this.directory,
        "rev-parse", "--verify", `refs/heads/${action.destination}`], { timeout: 5000, windowsHide: true })).stdout.trim();
    } catch { throw new Error(`Target branch ${action.destination} is unavailable`); }
    if (head !== action.baseRevision) throw new Error(`Target branch ${action.destination} changed after the action request`);
  }

  private async tasks(): Promise<TaskSnapshot> {
    let raw: string;
    try { raw = await readFile(this.tasksPath, "utf8"); }
    catch (error) {
      if (missing(error)) throw new Error(`No orch project at ${this.directory}. Run orch init first.`);
      throw error;
    }
    return new TaskGraph(JSON.parse(raw) as TaskSnapshot).snapshot();
  }
  private async state(): Promise<LocalState> {
    const snapshot = await this.tasks();
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as LocalState;
      if (state.version !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.audit)) throw new Error("Invalid command state");
      state.actions ??= {};
      return state;
    } catch (error) {
      if (!missing(error)) throw error;
      return { version: 1, revision: 0, project: { revision: 0, value: { id: randomUUID(), directory: this.directory } },
        plan: { revision: 0, value: { taskIds: snapshot.tasks.map((task) => task.spec.id) } }, checksRevision: 0, checks: {}, approvals: {}, actions: {}, runs: {},
        policy: { revision: 0, value: { rules: {} } }, audit: [] };
    }
  }
  async revision(): Promise<number> { return (await this.state()).revision; }
  async requireActionApproval(id: string): Promise<ActionRequest> {
    const state = await this.state();
    const gate = actionGate(state, id);
    if (gate) throw new Error(gate);
    await this.verifyMergeBase(state.actions[id].value);
    return { ...state.actions[id].value };
  }
  async register(documents?: string[]): Promise<ProjectRecord & { revision: number }> {
    if (!(await stat(this.directory)).isDirectory()) throw new Error("Project must be a directory");
    const selected = documents === undefined ? undefined : await documentsIn(this.directory, documents);
    await mkdir(join(this.directory, ".orch"), { recursive: true });
    try { await writeFile(this.tasksPath, '{\n  "tasks": []\n}\n', { flag: "wx" }); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    try { await writeFile(join(this.directory, ".orch", "models.json"), `${JSON.stringify(defaultRegistry(), null, 2)}\n`, { flag: "wx" }); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    const current = await this.state();
    const metadata = await discover(this.directory);
    const nextDocuments = selected ?? current.project.value.context?.documents ?? [];
    if (current.project.revision === 0 || JSON.stringify({ ...metadata, documents: nextDocuments }) !== JSON.stringify({ git: current.project.value.git, scripts: current.project.value.scripts, documents: current.project.value.context?.documents ?? [] })) {
      await this.execute({ version: 1, kind: "project.register", expectedRevision: current.revision, payload: { documents: nextDocuments } });
    }
    const state = await this.state();
    return { ...state.project.value, revision: state.project.revision };
  }
  private async ensureInitialized(): Promise<void> {
    try { await readFile(this.path); return; }
    catch (error) { if (!missing(error)) throw error; }
    try { await this.execute({ version: 1, kind: "project.update", expectedRevision: 0, payload: {} }); }
    catch (error) { if (!(error instanceof Error) || !error.message.startsWith("Stale revision:")) throw error; }
  }
  async detail(): Promise<LocalState & { tasks: TaskSnapshot["tasks"] }> {
    await this.ensureInitialized();
    return { ...await this.state(), tasks: (await this.tasks()).tasks };
  }
  async sharedView(): Promise<object> {
    await this.ensureInitialized();
    const state = await this.state();
    const projectId = opaqueId(state.project.value.id, "project id");
    // Construct the allowlist explicitly. Never spread local records or command payloads here.
    return { version: 1, revision: validRevision(state.revision, "state revision"), projectId,
      records: { project: validRevision(state.project.revision, "project revision"), context: validRevision(state.project.value.context?.version ?? 0, "context revision"), plan: validRevision(state.plan.revision, "plan revision"),
        checks: validRevision(state.checksRevision, "checks revision"),
        approvalRevisions: Object.values(state.approvals).map((record) => validRevision(record.revision, "approval revision")),
        actionRevisions: Object.values(state.actions).map((record) => validRevision(record.revision, "action revision")),
        runRevisions: Object.values(state.runs).map((record) => validRevision(record.revision, "run revision")), policy: validRevision(state.policy.revision, "policy revision") },
      audit: state.audit.map(({ id, at, kind, revision }) => {
        opaqueId(id, "audit id");
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)) throw new Error("Invalid audit timestamp");
        if (!["project.update", "project.register", "plan.add", "plan.retry", "plan.goal", "plan.answer", "plan.draft", "check.put", "check.result", "action.request", "approval.grant", "run.record", "policy.put", "policy.model", "policy.limits", "policy.route", "policy.rollback", "worktree.base"].includes(kind)) throw new Error("Invalid audit kind");
        return { id, at, kind, revision: validRevision(revision, "audit revision") };
      }) };
  }
  async execute(command: Command): Promise<CommandResult> {
    if (!command || command.version !== 1 || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new Error("Command needs version 1 and a nonnegative expectedRevision");
    }
    const payload = object(command.payload, "payload");
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockPath, "wx"); break; }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    if (!lock) throw new Error("Command state is busy");
    try {
      const state = await this.state();
      if (state.revision !== command.expectedRevision) throw new Error(`Stale revision: expected ${command.expectedRevision}, current ${state.revision}`);
      const next = state.revision + 1;
      let subjectId: string;
      let snapshot: TaskSnapshot | undefined;
      let registry: Awaited<ReturnType<typeof loadRegistry>> | undefined;
      switch (command.kind) {
        case "worktree.base": {
          const branch = string(payload.branch, "branch");
          const commit = string(payload.commit, "commit").toLowerCase();
          if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.includes(".lock")) throw new Error("Invalid base branch");
          if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Base needs an exact commit");
          if (payload.actor !== "user") throw new Error("Only user base approval is accepted");
          const gate = executionGate(state);
          if (gate) throw new Error(gate);
          const actual = (await execFileAsync("git", ["-c", `safe.directory=${this.directory.replace(/\\/g, "/")}`, "-C", this.directory,
            "rev-parse", "--verify", `refs/heads/${branch}`], { timeout: 5000, windowsHide: true })).stdout.trim().toLowerCase();
          if (actual !== commit) throw new Error(`Base branch ${branch} is not at ${commit}`);
          state.worktreeBase = { branch, commit, planRevision: state.plan.revision, checksRevision: state.checksRevision,
            contextVersion: state.project.value.context?.version ?? 0 };
          subjectId = branch;
          break;
        }
        case "project.register": {
          const documents = await documentsIn(this.directory, payload.documents);
          const previous = state.project.value.context;
          state.project.value = { ...state.project.value, ...await discover(this.directory), context: {
            version: previous ? previous.version + (JSON.stringify(previous.documents) === JSON.stringify(documents) ? 0 : 1) : 1,
            documents,
          } };
          state.project.revision++;
          subjectId = state.project.value.id;
          break;
        }
        case "project.update":
          if (payload.name !== undefined) state.project.value.name = string(payload.name, "name");
          else if (Object.keys(payload).length) throw new Error("project.update accepts name only");
          state.project.revision++;
          subjectId = state.project.value.id;
          break;
        case "plan.add": {
          snapshot = await this.tasks();
          const dependsOn = payload.dependsOn ?? [];
          if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string" || !id.trim()) || new Set(dependsOn).size !== dependsOn.length) throw new Error("--after needs unique, nonempty task IDs");
          const spec: TaskSpec = { id: nextTaskId(snapshot), description: string(payload.description, "description"),
            type: choice(payload.type ?? "other", types, "type"), difficulty: choice(payload.difficulty ?? "moderate", difficulties, "difficulty"),
            risk: choice(payload.risk ?? "medium", risks, "risk"), dependsOn };
          snapshot.tasks.push({ spec, status: "pending", attempts: [] });
          new TaskGraph(snapshot);
          state.plan.value.taskIds.push(spec.id);
          state.plan.revision++;
          subjectId = spec.id;
          break;
        }
        case "plan.retry": {
          const id = safeId(payload.taskId, "taskId");
          const graph = new TaskGraph(await this.tasks());
          graph.retry(id);
          snapshot = graph.snapshot();
          state.plan.revision++;
          subjectId = id;
          break;
        }
        case "plan.goal": {
          const goal = string(payload.goal, "goal");
          const proposed = questions(payload.questions);
          state.plan.value.draft = { goal, questions: proposed, answers: {}, tasks: proposed.length ? [] : draftTasks(payload.tasks), status: proposed.length ? "clarifying" : "review" };
          state.plan.revision++;
          generatedChecks(state);
          subjectId = "draft";
          break;
        }
        case "plan.answer": {
          const draft = state.plan.value.draft;
          if (!draft || draft.status !== "clarifying") throw new Error("No questions await answers");
          const supplied = object(payload.answers, "answers");
          if (Object.keys(supplied).length !== draft.questions.length || draft.questions.some((question) => !Object.hasOwn(supplied, question.id))) throw new Error("Answer every planning question");
          draft.answers = Object.fromEntries(draft.questions.map((question) => [question.id, string(supplied[question.id], `answer ${question.id}`)]));
          draft.tasks = draftTasks(payload.tasks);
          draft.status = "review";
          state.plan.revision++;
          generatedChecks(state);
          subjectId = "draft";
          break;
        }
        case "plan.draft": {
          const draft = state.plan.value.draft;
          if (!draft || draft.status !== "review") throw new Error("No draft to edit");
          draft.tasks = draftTasks(payload.tasks);
          state.plan.revision++;
          generatedChecks(state);
          subjectId = "draft";
          break;
        }
        case "check.put": {
          const id = opaqueId(payload.id ?? randomUUID(), "check id");
          const previous = state.checks[id];
          const value = checkValue(payload, payload.phase === "baseline" && payload.taskId === undefined ? "baseline" : "user");
          if (value.taskId && !(await this.tasks()).tasks.some((task) => task.spec.id === value.taskId) && !state.plan.value.draft?.tasks.some((task) => task.id === value.taskId)) throw new Error(`Unknown task: ${value.taskId}`);
          if (value.taskId && state.plan.value.draft?.tasks.some((task) => task.id === value.taskId)) value.planRevision = state.plan.revision;
          if (previous && previous.value.source !== "user") throw new Error("Generated and baseline checks cannot be edited; add a user check instead");
          if (previous && previous.value.taskId !== value.taskId) throw new Error("A check cannot move to another task");
          const revision = (previous?.revision ?? 0) + 1;
          state.checks[id] = { revision, value, history: [...(previous?.history ?? (previous ? [{ revision: previous.revision, value: previous.value }] : [])), { revision, value }], results: previous?.results ?? [] };
          state.checksRevision++;
          subjectId = id;
          break;
        }
        case "check.result": {
          const id = opaqueId(payload.id, "check id");
          const record = state.checks[id];
          if (!record) throw new Error(`Unknown check: ${id}`);
          if (record.revision !== payload.checkRevision) throw new Error("Stale check revision");
          const status = choice(payload.status, ["pass", "fail", "skipped", "missing"], "check status");
          if (record.value.command && (status === "pass" || status === "fail") && (!Number.isSafeInteger(payload.durationMs) || payload.exitCode !== null && !Number.isSafeInteger(payload.exitCode))) throw new Error("Executable result needs duration and exit code evidence");
          if (record.value.procedure && status === "pass" && payload.reviewer === undefined) throw new Error("Human review needs a named reviewer");
          const result: CheckResult = { at: new Date().toISOString(), checkRevision: record.revision, status,
            ...(payload.exitCode === undefined ? {} : { exitCode: payload.exitCode as number | null }),
            ...(payload.output === undefined ? {} : { output: string(payload.output, "output").slice(-8192) }),
            ...(payload.durationMs === undefined ? {} : { durationMs: validRevision(payload.durationMs, "durationMs") }),
            ...(payload.reason === undefined ? {} : { reason: string(payload.reason, "reason") }),
            ...(payload.reviewer === undefined ? {} : { reviewer: string(payload.reviewer, "reviewer") }) };
          if (status === "pass" && record.value.procedure && !result.reviewer) throw new Error("Human review needs a named reviewer");
          if ((status === "skipped" || status === "missing") && !result.reason) throw new Error(`${status} needs a reason`);
          record.results ??= [];
          record.results.push(result);
          subjectId = id;
          break;
        }
        case "action.request": {
          const id = opaqueId(payload.id ?? randomUUID(), "action id");
          const target = choice(payload.target, ["merge", "deployment"], "action target");
          const previous = state.actions[id];
          if (previous && previous.value.target !== target) throw new Error("An action cannot change type");
          const destination = string(payload.destination, "destination");
          if (destination.length > 200 || /[\r\n]/.test(destination)) throw new Error("Invalid destination");
          if (target === "merge" && (!/^(?!\/|.*(?:\.\.|\.lock(?:\/|$)|\/\/|[~^:?*\[\\]))[A-Za-z0-9._/-]+$/.test(destination) || destination.endsWith("/"))) throw new Error("Invalid target branch");
          const artifactRevision = string(payload.artifactRevision, "artifact revision");
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$/i.test(artifactRevision)) throw new Error("Artifact revision must be an exact commit or digest");
          const baseRevision = payload.baseRevision === undefined ? undefined : string(payload.baseRevision, "base revision");
          if (target === "merge" && (!baseRevision || !/^[0-9a-f]{40}$/i.test(baseRevision))) throw new Error("Merge needs the exact target branch head");
          if (target === "deployment" && baseRevision !== undefined) throw new Error("Deployment does not use a target branch head");
          state.actions[id] = { revision: (previous?.revision ?? 0) + 1, value: { target, destination, artifactRevision,
            ...(baseRevision ? { baseRevision } : {}), planRevision: state.plan.revision, checksRevision: state.checksRevision } };
          subjectId = id;
          break;
        }
        case "approval.grant": {
          const target = choice(payload.target, ["plan", "checks", "merge", "deployment"], "approval target");
          const targetRevision = payload.targetRevision;
          if (!Number.isSafeInteger(targetRevision) || (targetRevision as number) < 1) throw new Error("Invalid approval targetRevision");
          if (target === "plan" && targetRevision !== state.plan.revision) throw new Error("Stale plan approval");
          if (target === "plan" && state.plan.value.draft?.status === "clarifying") throw new Error("Answer planning questions before approval");
          if (target === "checks" && targetRevision !== state.checksRevision) throw new Error("Stale checks approval");
          const actionId = target === "merge" || target === "deployment" ? opaqueId(payload.actionId, "action id") : undefined;
          if (actionId) {
            const action = state.actions[actionId];
            if (!action || action.value.target !== target || action.revision !== targetRevision) throw new Error("Stale or mismatched action approval");
            if (action.value.planRevision !== state.plan.revision || action.value.checksRevision !== state.checksRevision) throw new Error("Action request needs revision after plan or checks changed");
            const prerequisite = executionGate(state);
            if (prerequisite) throw new Error(prerequisite);
            await this.verifyMergeBase(action.value);
          } else if (payload.actionId !== undefined) throw new Error("Plan and checks approvals cannot name an action");
          if (payload.actor !== "user") throw new Error("Only user approval is accepted");
          const id = opaqueId(payload.id ?? randomUUID(), "approval id");
          if (state.approvals[id]) throw new Error(`Approval already exists: ${id}`);
          if (hasApproval(state, target, targetRevision as number, actionId)) throw new Error("Revision is already approved");
          state.approvals[id] = { revision: 1, value: { target, targetRevision: targetRevision as number, actor: "user", ...(actionId ? { actionId } : {}), at: new Date().toISOString() } };
          subjectId = id;
          break;
        }
        case "run.record": {
          const id = opaqueId(payload.runId, "runId");
          const status = choice(payload.status, ["running", "finished", "failed", "paused"], "run status");
          const mode = choice(payload.mode, ["live", "simulated"], "run mode");
          const previous = state.runs[id];
          const runGate = executionGate(state) ?? (mode === "live" ? worktreeBaseGate(state) : undefined);
          if (previous && previous.value.mode !== mode) throw new Error("Run mode cannot change");
          if (status === "paused" && previous && previous.value.status !== "running") throw new Error("Run is not running");
          if (status === "running" && previous && previous.value.status !== "paused") throw new Error("Run is not paused");
          if (status === "running" && runGate) throw new Error(runGate);
          const pauseReason = status === "paused" ? (runGate ?? (payload.reason === undefined ? undefined : string(payload.reason, "pause reason"))) : undefined;
          if (status === "paused" && !pauseReason) throw new Error("A pause reason is required");
          if ((status === "finished" || status === "failed") && previous?.value.status !== "running") throw new Error("Run is not running");
          if (previous?.value.status === "finished" || previous?.value.status === "failed") throw new Error("Run already ended");
          state.runs[id] = { revision: (previous?.revision ?? 0) + 1, value: { status, mode,
            planRevision: state.plan.revision, checksRevision: state.checksRevision,
            ...(status === "paused" ? { reason: pauseReason } : {}) } };
          subjectId = id;
          break;
        }
        case "policy.put": {
          state.policy.value.rules = object(payload.rules, "rules");
          state.policy.revision++;
          subjectId = "policy";
          break;
        }
        case "policy.limits":
        case "policy.route":
        case "policy.rollback": {
          const before = structuredClone(state.policy.value.routing ?? emptyRouting());
          const after = structuredClone(before);
          const history = state.policy.value.history ?? [];
          let cause: PolicyRevision["cause"];
          let author: PolicyRevision["author"];
          let reason: string;
          let evidenceIds: string[] = [];
          let baseline: PolicyRevision["baseline"];
          let candidate: PolicyRevision["candidate"];
          let priceVersion: string | undefined;
          let currency: string | undefined;
          if (command.kind === "policy.limits") {
            if (payload.actor !== "user") throw new Error("Only the user can change routing limits");
            after.limits = parseLimits(payload.limits);
            cause = "limits"; author = "user";
            reason = string(payload.reason, "reason");
          } else if (command.kind === "policy.rollback") {
            if (payload.actor !== "user") throw new Error("Only the user can roll back routing");
            const target = payload.targetVersion;
            if (!Number.isSafeInteger(target) || (target as number) < 0 || (target as number) >= state.policy.revision) throw new Error("Invalid rollback version");
            const old = target === 0 ? emptyRouting() : history.find((item) => item.version === target)?.after;
            if (!old) throw new Error("Rollback target has no routing snapshot");
            after.rules = structuredClone(old.rules);
            cause = "rollback"; author = "user";
            reason = string(payload.reason, "reason");
          } else {
            const taskId = safeId(payload.taskId, "task ID");
            const task = (await this.tasks()).tasks.find((record) => record.spec.id === taskId)?.spec;
            if (!task) throw new Error(`Unknown task: ${taskId}`);
            registry = await loadRegistry(this.directory);
            const attempts = (await new KnowledgeStore(this.directory).list("project")).filter((entry): entry is AttemptEntry => entry.kind === "attempt");
            const prices = JSON.parse(await readFile(join(this.directory, ".orch", "prices.json"), "utf8")) as PriceSnapshot;
            const proposal = recommendModelRoute({ task, registry, attempts, prices });
            if (!proposal.recommendedAlias || !proposal.baseline || !proposal.candidate) throw new Error(`No validated automatic route: ${proposal.reason}`);
            const chosen = registry.models.find((item) => item.alias === proposal.recommendedAlias)!;
            const fallback = registry.models.find((item) => item.alias === proposal.fallbackAlias)!;
            for (const profile of [chosen, fallback]) {
              const check = allowedProfile(profile, after.limits, task, registry, attempts, prices);
              if (!check.allowed) throw new Error(`Route ${profile.alias} violates user limits: ${check.reason}`);
            }
            after.rules[routeKey(task)] = { alias: chosen.alias, fallbackAlias: fallback.alias };
            baseline = proposal.baseline; candidate = proposal.candidate;
            evidenceIds = [...new Set([...baseline.evidenceIds, ...candidate.evidenceIds])];
            if (evidenceIds.length !== baseline.attemptCount + candidate.attemptCount) throw new Error("Automatic route needs identified live attempt evidence");
            priceVersion = proposal.priceVersion; currency = proposal.currency;
            cause = "live-outcomes"; author = "orch"; reason = proposal.reason;
          }
          if (JSON.stringify(before) === JSON.stringify(after)) throw new Error("Routing policy is unchanged");
          const version = state.policy.revision + 1;
          history.push({ version, at: new Date().toISOString(), author, cause, reason, before, after: structuredClone(after),
            evidenceIds, ...(priceVersion ? { priceVersion } : {}), ...(currency ? { currency } : {}),
            ...(baseline ? { baseline } : {}), ...(candidate ? { candidate } : {}), rollbackTo: state.policy.revision });
          state.policy.value.routing = after;
          state.policy.value.history = history;
          state.policy.revision = version;
          subjectId = "policy";
          registry = undefined;
          break;
        }
        case "policy.model": {
          registry = await loadRegistry(this.directory);
          const action = choice(payload.action, ["add", "enable", "disable", "weight"], "model action");
          const alias = safeId(payload.alias, "model alias");
          if (action === "add") {
            if (registry.models.some((item) => item.alias === alias)) throw new Error(`Model alias already exists: ${alias}`);
            const model = { ...object(payload.model, "model"), alias } as unknown as ModelProfile;
            validateProfile(model);
            registry.models.push(model);
          } else {
            const model = registry.models.find((item) => item.alias === alias);
            if (!model) throw new Error(`Unknown model alias: ${alias}`);
            if (action === "weight") model.weight = Number(payload.weight);
            else model.enabled = action === "enable";
            validateProfile(model);
          }
          registry.policyVersion = (registry.policyVersion ?? 1) + 1;
          state.policy.revision++;
          subjectId = "policy";
          break;
        }
        default: throw new Error(`Unknown command kind: ${String(command.kind)}`);
      }
      state.revision = next;
      const auditId = randomUUID();
      state.audit.push({ id: auditId, at: new Date().toISOString(), kind: command.kind, revision: next, subjectId });
      if ((command.kind === "plan.goal" || command.kind === "plan.answer" || command.kind === "plan.draft") && state.plan.value.draft?.status === "review") {
        for (const task of state.plan.value.draft.tasks) for (const artifact of task.testArtifacts ?? []) {
          const file = join(this.directory, ".orch", "generated-tests", `plan-r${state.plan.revision}`, task.id, artifact.name);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, artifact.content, { encoding: "utf8", flag: "wx" });
        }
      }
      // The legacy task file remains the executable graph and is written only after validation.
      if (snapshot) await atomicWrite(this.tasksPath, snapshot);
      if (registry) await saveRegistry(this.directory, registry);
      await atomicWrite(this.path, state);
      return { revision: next, auditId, subjectId };
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
