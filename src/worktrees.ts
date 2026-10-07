import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CommandService, worktreeBaseGate } from "./command-service";
import { TaskSpec } from "./types";
import { Executor } from "./executor";
import { CodexExecutor } from "./providers";
import { ModelRegistry } from "./models";
import { ExecutionResult, Route } from "./types";
import { runCheck } from "./checks";

const exec = promisify(execFile);
interface WorkerRecord { taskId: string; branch: string; path: string; approvedBase: string; targetBranch: string; base: string; dependencies: Record<string, string>; integrationIds?: string[]; contextDocuments: string[]; lessonIds: string[]; contextId?: string; commit?: string; validation?: { passed: boolean; command: string; output: string } }
interface IntegrationRecord { id: string; branch: string; path: string; target: string; base: string; taskIds: string[]; conflicts: string[]; diff: string; commit?: string; check?: { command: string; passed: boolean; output: string }; actionId?: string; merged?: boolean }
interface WorktreeState { workers: Record<string, WorkerRecord>; integrations: Record<string, IntegrationRecord> }

export class WorktreeManager {
  private readonly project: string;
  private readonly service: CommandService;
  private state: WorktreeState = { workers: {}, integrations: {} };
  private pending: Promise<void> = Promise.resolve();
  constructor(project: string) { this.project = resolve(project); this.service = new CommandService(this.project); }
  get projectPath(): string { return this.project; }
  private get statePath(): string { return join(this.project, ".orch", "worktrees.json"); }
  private async git(cwd: string, ...args: string[]): Promise<string> {
    const safe = (path: string) => path.replace(/\\/g, "/");
    const result = await exec("git", ["-c", `safe.directory=${safe(this.project)}`, "-c", `safe.directory=${safe(cwd)}`, "-C", cwd, ...args],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
  }
  async load(): Promise<this> {
    try { this.state = JSON.parse(await readFile(this.statePath, "utf8")) as WorktreeState; }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    return this;
  }
  private async save(): Promise<void> {
    const write = async () => {
      await mkdir(join(this.project, ".orch"), { recursive: true });
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { flag: "wx" }); await rename(temporary, this.statePath); }
      finally { await rm(temporary, { force: true }); }
    };
    this.pending = this.pending.then(write, write);
    await this.pending;
  }
  private async approvedBase(): Promise<{ branch: string; commit: string }> {
    const state = await this.service.detail();
    const gate = worktreeBaseGate(state);
    if (gate) throw new Error(gate);
    const base = state.worktreeBase!;
    if (await this.git(this.project, "rev-parse", `refs/heads/${base.branch}`) !== base.commit) throw new Error("Approved base branch has moved");
    return base;
  }
  async prepare(task: TaskSpec, lessonIds: string[] = []): Promise<WorkerRecord> {
    if (!/^[A-Za-z0-9_-]+$/.test(task.id)) throw new Error("Invalid task ID for a worktree");
    const approved = await this.approvedBase();
    const existing = this.state.workers[task.id];
    if (existing) {
      if (existing.approvedBase !== approved.commit || existing.targetBranch !== approved.branch) throw new Error(`Task ${task.id} belongs to a different approved base`);
      if (existing.validation?.passed) throw new Error(`Task ${task.id} already has a validated worktree`);
      return existing;
    }
    const dependencies: Record<string, string> = {};
    for (const id of task.dependsOn) {
      const worker = this.state.workers[id];
      if (!worker?.validation?.passed || !worker.commit) throw new Error(`Dependency ${id} has no validated commit`);
      if (worker.approvedBase !== approved.commit || worker.targetBranch !== approved.branch) throw new Error(`Dependency ${id} belongs to a different approved base`);
      dependencies[id] = worker.commit;
    }
    const covered = new Set<string>();
    const integrationIds: string[] = [];
    const mergeCommits: string[] = [];
    const integrations = Object.values(this.state.integrations).filter((record) =>
      record.base === approved.commit && record.target === approved.branch && record.commit &&
      record.check?.passed && record.conflicts.length === 0 && record.taskIds.length > 1 &&
      record.taskIds.every((id) => task.dependsOn.includes(id) && dependencies[id])).sort((a, b) => b.taskIds.length - a.taskIds.length);
    for (const integration of integrations) {
      if (integration.taskIds.some((id) => covered.has(id))) continue;
      integrationIds.push(integration.id);
      mergeCommits.push(integration.commit!);
      for (const id of integration.taskIds) covered.add(id);
    }
    for (const id of task.dependsOn) if (!covered.has(id)) mergeCommits.push(dependencies[id]);
    const id = randomUUID();
    const branch = `orch/task-${task.id}-${id}`;
    const path = join(this.project, ".orch", "worktrees", `task-${task.id}-${id}`);
    await mkdir(join(this.project, ".orch", "worktrees"), { recursive: true });
    await this.git(this.project, "worktree", "add", "-b", branch, path, approved.commit);
    try {
      for (const [index, commit] of [...new Set(mergeCommits)].entries()) {
        await this.git(path, "-c", "user.name=Orch", "-c", "user.email=orch@localhost", "merge", "--no-ff", "-m", `Integrate dependency base ${index + 1}`, commit);
      }
    } catch (error) {
      await this.git(path, "merge", "--abort").catch(() => undefined);
      await this.git(this.project, "worktree", "remove", "--force", path);
      await this.git(this.project, "branch", "-D", branch);
      throw new Error(`Dependency base for ${task.id} conflicts: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const state = await this.service.detail();
      for (const document of state.project.value.context?.documents ?? []) {
        try {
          const actual = await realpath(join(path, document));
          if (!(actual.startsWith(path + sep)) || !(await stat(actual)).isFile()) throw new Error("not a worktree file");
        } catch { throw new Error(`Pinned context document ${document} is unavailable in ${task.id} worktree`); }
      }
      const generated = join(this.project, ".orch", "generated-tests", `plan-r${state.plan.revision}`, task.id);
      try {
        await stat(generated);
        const destination = join(path, ".orch", "generated-tests", `plan-r${state.plan.revision}`, task.id);
        await mkdir(dirname(destination), { recursive: true });
        await cp(generated, destination, { recursive: true });
      } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      const record: WorkerRecord = { taskId: task.id, branch, path, approvedBase: approved.commit, targetBranch: approved.branch,
        base: await this.git(path, "rev-parse", "HEAD"), dependencies, integrationIds,
        contextDocuments: state.project.value.context?.documents ?? [], lessonIds };
      this.state.workers[task.id] = record;
      await this.save();
      return record;
    } catch (error) {
      delete this.state.workers[task.id];
      await this.git(this.project, "worktree", "remove", "--force", path).catch(() => undefined);
      await this.git(this.project, "branch", "-D", branch).catch(() => undefined);
      throw error;
    }
  }
  async markPrompt(taskId: string, lessonIds: string[]): Promise<void> {
    const record = this.state.workers[taskId];
    if (!record) throw new Error(`No worktree for ${taskId}`);
    record.lessonIds = [...lessonIds];
    await this.save();
  }
  async finish(taskId: string, contextId: string | undefined, command: string, passed: boolean, output: string): Promise<WorkerRecord> {
    const record = this.state.workers[taskId];
    if (!record) throw new Error(`No worktree for ${taskId}`);
    record.contextId = contextId;
    record.validation = { command, passed, output: output.slice(-8192) };
    if (passed) {
      await this.git(record.path, "add", "-A", "--", ".", ":(exclude).orch");
      if (await this.git(record.path, "status", "--porcelain", "--untracked-files=no")) {
        await this.git(record.path, "-c", "user.name=Orch", "-c", "user.email=orch@localhost", "commit", "-m", `Complete ${taskId}`);
      }
      record.commit = await this.git(record.path, "rev-parse", "HEAD");
    }
    await this.save();
    return record;
  }
  async detail(): Promise<WorktreeState> { return JSON.parse(JSON.stringify(this.state)) as WorktreeState; }
  async integrate(taskIds: string[], checkCommand: string): Promise<IntegrationRecord> {
    if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error("Integration needs unique task IDs");
    if (!checkCommand.trim()) throw new Error("Integration needs a validation command");
    const approved = await this.approvedBase();
    const workers = taskIds.map((id) => {
      const record = this.state.workers[id];
      if (!record?.validation?.passed || !record.commit) throw new Error(`Task ${id} has no validated commit`);
      if (record.approvedBase !== approved.commit || record.targetBranch !== approved.branch) throw new Error(`Task ${id} was built from a different approved base`);
      return record;
    });
    const id = randomUUID();
    const branch = `orch/integration-${id}`;
    const path = join(this.project, ".orch", "worktrees", `integration-${id}`);
    await this.git(this.project, "worktree", "add", "-b", branch, path, approved.commit);
    const integration: IntegrationRecord = { id, branch, path, target: approved.branch, base: approved.commit, taskIds, conflicts: [], diff: "" };
    this.state.integrations[id] = integration;
    for (const worker of workers) {
      try {
        await this.git(path, "-c", "user.name=Orch", "-c", "user.email=orch@localhost", "merge", "--no-ff", "-m", `Integrate ${worker.taskId}`, worker.commit!);
      } catch (error) {
        integration.conflicts = (await this.git(path, "diff", "--name-only", "--diff-filter=U")).split(/\r?\n/).filter(Boolean);
        integration.diff = await this.git(path, "diff");
        await this.save();
        if (!integration.conflicts.length) throw error;
        return integration;
      }
    }
    integration.commit = await this.git(path, "rev-parse", "HEAD");
    integration.diff = await this.git(path, "diff", `${approved.commit}..HEAD`, "--");
    const check = await new Promise<{ passed: boolean; output: string }>((done) => {
      const child = spawn(checkCommand, { cwd: path, shell: true, windowsHide: true, timeout: 600_000 });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); });
      child.on("error", (error: Error) => { output = (output + error.message).slice(-8192); });
      child.on("close", (code: number | null) => done({ passed: code === 0, output }));
    });
    const changedByCheck = await this.git(path, "status", "--porcelain", "--untracked-files=no");
    integration.check = { command: checkCommand, passed: check.passed && !changedByCheck,
      output: changedByCheck ? `${check.output}\nIntegration check changed tracked files: ${changedByCheck}`.trim() : check.output };
    await this.save();
    if (integration.check.passed) {
      const action = await this.service.execute({ version: 1, kind: "action.request", expectedRevision: await this.service.revision(),
        payload: { target: "merge", destination: approved.branch, artifactRevision: integration.commit, baseRevision: approved.commit } });
      integration.actionId = action.subjectId;
    }
    await this.save();
    return integration;
  }
  async verifyIntegration(id: string, checkCommand: string): Promise<IntegrationRecord> {
    if (!checkCommand.trim()) throw new Error("Integration needs a validation command");
    const integration = this.state.integrations[id];
    if (!integration) throw new Error(`Unknown integration: ${id}`);
    const approved = await this.approvedBase();
    if (integration.base !== approved.commit || integration.target !== approved.branch) throw new Error("Integration belongs to a different approved base");
    if (await this.git(integration.path, "symbolic-ref", "--short", "HEAD") !== integration.branch) throw new Error("Integration branch changed");
    if (await this.git(integration.path, "diff", "--name-only", "--diff-filter=U")) throw new Error("Resolve all integration conflicts before verification");
    if (await this.git(integration.path, "status", "--porcelain", "--untracked-files=no")) throw new Error("Commit the resolved integration before verification");
    const head = await this.git(integration.path, "rev-parse", "HEAD");
    for (const taskId of integration.taskIds) {
      const worker = this.state.workers[taskId];
      if (!worker?.validation?.passed || !worker.commit || worker.approvedBase !== approved.commit) throw new Error(`Task ${taskId} has no validated commit for this base`);
      try { await this.git(integration.path, "merge-base", "--is-ancestor", worker.commit, head); }
      catch { throw new Error(`Resolved integration does not include ${taskId}`); }
    }
    const check = await new Promise<{ passed: boolean; output: string }>((done) => {
      const child = spawn(checkCommand, { cwd: integration.path, shell: true, windowsHide: true, timeout: 600_000 });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); });
      child.on("error", (error: Error) => { output = (output + error.message).slice(-8192); });
      child.on("close", (code: number | null) => done({ passed: code === 0, output }));
    });
    const changed = await this.git(integration.path, "status", "--porcelain", "--untracked-files=no");
    integration.check = { command: checkCommand, passed: check.passed && !changed,
      output: changed ? `${check.output}\nIntegration check changed tracked files: ${changed}`.trim() : check.output };
    if (integration.check.passed) {
      integration.conflicts = [];
      integration.commit = head;
      integration.diff = await this.git(integration.path, "diff", `${approved.commit}..HEAD`, "--");
      if (!integration.actionId) {
        const action = await this.service.execute({ version: 1, kind: "action.request", expectedRevision: await this.service.revision(),
          payload: { target: "merge", destination: approved.branch, artifactRevision: head, baseRevision: approved.commit } });
        integration.actionId = action.subjectId;
      }
    }
    await this.save();
    return integration;
  }
  async merge(actionId: string): Promise<IntegrationRecord> {
    const integration = Object.values(this.state.integrations).find((record) => record.actionId === actionId);
    if (!integration || integration.merged || !integration.commit || !integration.check?.passed || integration.conflicts.length) throw new Error("No validated integration for this action");
    const action = await this.service.requireActionApproval(actionId);
    const approved = await this.approvedBase();
    if (approved.branch !== integration.target || approved.commit !== integration.base) throw new Error("Approved worktree base changed after integration");
    if (action.target !== "merge" || action.artifactRevision !== integration.commit || action.baseRevision !== integration.base || action.destination !== integration.target) throw new Error("Merge approval does not match integration");
    if (await this.git(integration.path, "rev-parse", "HEAD") !== integration.commit) throw new Error("Integrated revision changed after validation");
    if (await this.git(this.project, "symbolic-ref", "--short", "HEAD") !== integration.target) throw new Error("Target branch must be checked out in the project worktree");
    if (await this.git(this.project, "status", "--porcelain", "--untracked-files=no")) throw new Error("Target worktree has tracked changes");
    await this.git(this.project, "merge", "--ff-only", integration.commit);
    integration.merged = true;
    await this.save();
    return integration;
  }
}

export class WorktreeCodexExecutor implements Executor {
  readonly parallel = true;
  constructor(private readonly manager: WorktreeManager, private readonly registry: ModelRegistry,
    private readonly checkCommand: string, private readonly lessons: (task: TaskSpec) => { ids: string[]; text: string[] },
    private readonly timeoutMs: number, private readonly onPrompt: (task: TaskSpec) => Promise<void> | void,
    private readonly taskContext: (task: TaskSpec) => string[] = () => []) {}
  async execute(task: TaskSpec, route: Route, attempt: number): Promise<ExecutionResult> {
    const lessons = this.lessons(task);
    const resumingWorktree = Boolean((await this.manager.detail()).workers[task.id]);
    const record = await this.manager.prepare(task);
    const context = [
      `Worker branch: ${record.branch}; pinned base: ${record.base}.`,
      `Dependency commits: ${JSON.stringify(record.dependencies)}.`,
      `Project documents: ${record.contextDocuments.join(", ") || "none"}.`,
      ...(resumingWorktree ? ["This worktree contains prior worker output. Inspect its changes and finish or verify that work before editing."] : []),
      ...this.taskContext(task),
    ];
    const executor = new CodexExecutor(record.path, this.registry, this.checkCommand, () => lessons.text,
      this.timeoutMs, async (started) => { await this.manager.markPrompt(task.id, lessons.ids); await this.onPrompt(started); }, () => context);
    const result = await executor.execute(task, route, attempt);
    if (result.capacityReason) return { ...result, worktree: record.path };
    const service = new CommandService(this.manager.projectPath);
    const state = await service.detail();
    const checkIds = Object.entries(state.checks).filter(([, check]) => check.value.taskId === task.id && check.value.phase === "task" &&
      check.value.command && (check.value.planRevision === undefined || check.value.planRevision === state.plan.revision)).map(([id]) => id);
    const failures: string[] = [];
    if (result.succeeded) for (const id of checkIds) {
      const check = await runCheck(service, id, record.path);
      if (check.status !== "pass") failures.push(`${id}: ${check.status}${check.reason ? ` (${check.reason})` : ""}`);
    }
    const passed = result.succeeded && failures.length === 0;
    const error = failures.length ? `Approved task checks failed: ${failures.join("; ")}` : result.error;
    const finished = await this.manager.finish(task.id, result.contextId, this.checkCommand, passed, error ?? result.checkOutput ?? "Validation passed");
    return { ...result, succeeded: passed, ...(error ? { error } : {}), worktree: record.path,
      ...(finished.commit ? { commit: finished.commit } : {}) };
  }
}
