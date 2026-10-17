#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { renameWithRetry } from "./rename-with-retry";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FakeExecutor } from "./executor";
import { KnowledgeScope, KnowledgeStore, SelectedLesson } from "./knowledge";
import { createLocalApi } from "./local-api";
import { actionGate, Command, CommandService, executionGate, taskVerificationGate, worktreeBaseGate } from "./command-service";
import { checkReport, runBaseline, runCheck } from "./checks";
import { PlanningWorkflow } from "./planning";
import { PriceSnapshot, recommendModelRoute } from "./model-decisions";
import { loadRegistry, ModelProfile, ProviderId, selectModel, validateProfile } from "./models";
import { orchestrate } from "./orchestrator";
import { smokeCodex } from "./providers";
import { routeReason, routeTask } from "./router";
import { readRunEvents, RunEventWriter } from "./run-events";
import { TaskGraph } from "./scheduler";
import { Difficulty, Risk, Route, TaskSnapshot, TaskSpec, TaskType } from "./types";
import { WorktreeCodexExecutor, WorktreeManager } from "./worktrees";
import { CapacityScheduler, capacityAvailability, readCapacity } from "./capacity";
import { PostgresMetadata } from "./postgres-metadata";
import { NeonMetadata, neonConfig, NeonEnvironment } from "./neon-metadata";
import { localSharedSnapshot } from "./shared-metadata";
import { neonEnvironmentFile, StorageService } from "./storage";
import { executionPreflight } from "./preflight";
import { constrainProposal, resolveRoute } from "./routing-policy";
import { nextRoute } from "./escalation";

type Options = Record<string, string | boolean>;

const taskTypes: TaskType[] = ["rename", "refactor", "analysis", "test", "other"];
const difficulties: Difficulty[] = ["easy", "moderate", "hard", "extreme"];
const risks: Risk[] = ["low", "medium", "high", "critical"];

function usage(): string {
  return [
    "orch — dependency-aware task runner",
    "",
    "Usage:",
    "  orch init [directory] [--docs README.md,docs/architecture.md]",
    "  orch plan <description> [--type rename|refactor|analysis|test|other]",
    "       [--difficulty easy|moderate|hard|extreme] [--risk low|medium|high|critical]",
    "       [--after TASK-001,TASK-002] [--project directory]",
    "  orch draft start <goal> [--project directory]",
    "  orch draft show [--project directory]",
    "  orch draft answer --file answers.json [--project directory]",
    "  orch draft edit --file tasks.json [--project directory]",
    "  orch draft approve [--project directory]",
    "  orch checks approve [--project directory]  (requires a task or review check for every draft criterion)",
    "  orch checks baseline|list [TASK-001] [--project directory]",
    "  orch checks history <check-id> [--project directory]",
    "  orch checks add TASK-001 --command 'npm test' --phase task --timeout-seconds 600 --expected 'exit 0' [--cwd .] [--criterion text] [--project directory]",
    "  orch checks run <check-id>|task TASK-001 [--project directory]",
    "  orch checks skip <check-id> --reason text [--project directory]",
    "  orch checks review <check-id> --reviewer name [--project directory]  (after worker output)",
    "  orch status [--project directory]",
    "  orch preflight [--project directory] [--executor fake|codex] [--check 'npm test']",
    "  orch capacity [--project directory]  (show measured or unknown provider capacity)",
    "  orch retry TASK-001 [--preserve|--discard] [--project directory]  (after the prior run stops)",
    "  orch run [--once] [--resume RUN-ID] [--project directory] [--executor fake|codex] [--check 'npm test'] [--timeout-seconds 600]",
    "  orch worktrees base <branch> <commit> [--project directory]",
    "  orch worktrees show [--project directory]",
    "  orch worktrees integrate TASK-001,TASK-002 --check 'npm test' [--project directory]",
    "  orch worktrees verify <integration-id> --check 'npm test' [--project directory]  (after resolving and committing conflicts)",
    "  orch worktrees merge <approved-action-id> [--project directory]",
    "  orch actions request merge|deployment <destination> <artifact-revision> [--base-revision TARGET-HEAD] [--id ACTION-ID] [--project directory]",
    "  orch actions show|approve|ready <action-id> [--project directory]",
    "  orch doctor codex [--project directory] [--timeout-seconds 60]",
    "  orch models list|add|enable|disable|weight ... [--project directory]",
    "  orch models recommend TASK-001 --prices snapshot.json [--manual-alias alias] [--project directory]",
    "  orch models limits --file limits.json --reason text [--project directory]",
    "  orch models apply TASK-001 [--project directory]  (use .orch/prices.json and live outcomes)",
    "  orch models policy [--project directory]  (rules, limits, and versioned history)",
    "  orch models rollback VERSION --reason text [--project directory]",
    "  orch knowledge add <note> [--type rename|refactor|analysis|test|other] [--project directory]",
    "  orch knowledge list [--scope project|global] [--project directory]",
    "  orch knowledge review <id> --status pending|approved|rejected [--project directory]  (approving a candidate creates a reviewed lesson)",
    "  orch knowledge promote <id> [--project directory]",
    "  orch knowledge edit <id> <new text> [--project directory]",
    "  orch knowledge remove <id> [--scope project|global] [--project directory]",
    "  orch knowledge export [--scope project|global] [--output file] [--project directory]",
    "  orch history [--project directory]",
    "  orch serve [--project directory] [--port 8765]  (local API)",
    "  orch command --json '{...}' [--project directory]  (versioned local command)",
    "  orch shared migrate|sync|runs [--project directory]  (Docker Postgres)",
    "  orch shared neon status|diagnose|sync|runs|migrate --environment development|production [--env-file path] [--project directory]",
    "  orch skill install [--to skills-directory] [--force]",
    "  orch help",
    "",
    "Plan creates one task; it does not split a goal into subtasks.",
    "Run defaults to fake workers. --once processes one ready task. Codex runs can edit code and require --check.",
  ].join("\n");
}

function parseArguments(args: string[], allowed: string[]): { positionals: string[]; options: Options } {
  const positionals: string[] = [];
  const options: Options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!allowed.includes(name)) throw new Error(`Unknown option: ${token}`);
    if (name === "force" || name === "enable" || name === "once" || name === "preserve" || name === "discard") {
      if (options[name] !== undefined) throw new Error(`Option ${token} was provided twice`);
      options[name] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Option ${token} needs a value`);
    if (options[name] !== undefined) throw new Error(`Option ${token} was provided twice`);
    options[name] = value;
  }
  return { positionals, options };
}

function option(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`Invalid ${name}: ${value}. Choose ${allowed.join(", ")}`);
}

function statePath(project: string): string {
  return join(project, ".orch", "tasks.json");
}

async function loadGraph(project: string): Promise<TaskGraph> {
  let source: string;
  try {
    source = await readFile(statePath(project), "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`No orch project at ${project}. Run orch init first.`);
    throw error;
  }
  const snapshot: unknown = JSON.parse(source);
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray((snapshot as TaskSnapshot).tasks)) {
    throw new Error("Invalid .orch/tasks.json: expected a tasks array");
  }
  return new TaskGraph(snapshot as TaskSnapshot);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function saveSnapshot(project: string, snapshot: TaskSnapshot): Promise<void> {
  const target = statePath(project);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await renameWithRetry(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function init(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["docs"]);
  if (positionals.length > 1) throw new Error("init accepts at most one directory");
  const project = resolve(positionals[0] ?? process.cwd());
  await mkdir(project, { recursive: true });
  const existed = await readFile(statePath(project), "utf8").then(() => true, (error: unknown) => { if (isMissing(error)) return false; throw error; });
  const docs = option(options, "docs");
  const registered = await new CommandService(project).register(docs === undefined ? undefined : docs.split(",").map((item) => item.trim()));
  await ensureProjectIgnore(project);
  console.log(`${existed ? "Already initialized" : "Initialized orch in"}: ${project}`);
  console.log(`Project ID: ${registered.id}; context version: ${registered.context?.version}`);
}

async function ensureProjectIgnore(project: string): Promise<void> {
  try {
    await writeFile(join(project, ".orch", ".gitignore"), "knowledge.jsonl\nknowledge.v*.json\nknowledge.v*.json.lock\nruns.jsonl\ncommands.v*.json\ncommands.v*.json.lock\nworktrees.json\nworktrees/\n*.db*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    const target = join(project, ".orch", ".gitignore");
    const content = await readFile(target, "utf8");
    const lines = new Set(content.split(/\r?\n/));
    if (content && !content.endsWith("\n")) await appendFile(target, "\n", "utf8");
    for (const pattern of ["runs.jsonl", "knowledge.v*.json", "knowledge.v*.json.lock", "commands.v*.json", "commands.v*.json.lock", "worktrees.json", "worktrees/"]) {
      if (!lines.has(pattern)) await appendFile(target, `${pattern}\n`, "utf8");
    }
  }
}

async function plan(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["type", "difficulty", "risk", "after", "project"]);
  const description = positionals.join(" ").trim();
  if (!description) throw new Error("plan needs a task description");
  const project = resolve(option(options, "project") ?? process.cwd());
  const dependsOn = option(options, "after")?.split(",").map((id) => id.trim()) ?? [];
  if (dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length) {
    throw new Error("--after needs unique, nonempty task IDs");
  }
  const spec = {
    description,
    type: oneOf(option(options, "type"), taskTypes, "other", "type"),
    difficulty: oneOf(option(options, "difficulty"), difficulties, "moderate", "difficulty"),
    risk: oneOf(option(options, "risk"), risks, "medium", "risk"),
    dependsOn,
  };
  const service = new CommandService(project);
  const result = await service.execute({ version: 1, kind: "plan.add", expectedRevision: await service.revision(), payload: spec });
  console.log(`Added ${result.subjectId}: ${spec.description}`);
  console.log(`Route: ${routeTask({ ...spec, id: result.subjectId }).label}; dependencies: ${dependsOn.join(", ") || "none"}`);
}

async function draft(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { positionals, options } = parseArguments(rest, ["project", "file"]);
  const project = resolve(option(options, "project") ?? process.cwd());
  const service = new CommandService(project);
  if (action === "start") {
    if (!positionals.length || option(options, "file")) throw new Error("draft start needs a goal");
    console.error("Drafting plan with Codex. This may take a few minutes; no workers are running.");
    await new PlanningWorkflow(project).start(positionals.join(" "));
  } else if (action === "answer") {
    if (positionals.length || !option(options, "file")) throw new Error("draft answer needs --file answers.json");
    const answers = JSON.parse(await readFile(resolve(option(options, "file")!), "utf8")) as Record<string, string>;
    await new PlanningWorkflow(project).answer(answers, await service.revision());
  } else if (action === "edit") {
    if (positionals.length || !option(options, "file")) throw new Error("draft edit needs --file tasks.json");
    const tasks = JSON.parse(await readFile(resolve(option(options, "file")!), "utf8")) as unknown;
    await service.execute({ version: 1, kind: "plan.draft", expectedRevision: await service.revision(), payload: { tasks } });
  } else if (action === "approve") {
    if (positionals.length || option(options, "file")) throw new Error("draft approve takes no additional arguments");
    const state = await service.detail();
    if (state.plan.value.draft?.status !== "review") throw new Error("No draft awaits review");
    await service.execute({ version: 1, kind: "approval.grant", expectedRevision: state.revision,
      payload: { target: "plan", targetRevision: state.plan.revision, actor: "user" } });
  } else if (action !== "show" || positionals.length || option(options, "file")) throw new Error("Use orch draft start|show|answer|edit|approve");
  const state = await service.detail();
  console.log(JSON.stringify({ revision: state.revision, planRevision: state.plan.revision, draft: state.plan.value.draft ?? null,
    approved: Object.values(state.approvals).some((record) => record.value.target === "plan" && record.value.targetRevision === state.plan.revision) }, null, 2));
}

async function checks(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  const { positionals, options } = parseArguments(rest, ["project", "command", "procedure", "phase", "timeout-seconds", "expected", "cwd", "criterion", "reason", "reviewer", "id"]);
  const service = new CommandService(resolve(option(options, "project") ?? process.cwd()));
  if (action === "approve") {
    if (positionals.length) throw new Error("checks approve takes no check ID");
    const state = await service.detail();
    const result = await service.execute({ version: 1, kind: "approval.grant", expectedRevision: state.revision,
      payload: { target: "checks", targetRevision: state.checksRevision, actor: "user" } });
    console.log(`Checks revision ${state.checksRevision} approved (${result.subjectId})`);
    return 0;
  }
  if (action === "baseline") {
    if (positionals.length) throw new Error("checks baseline takes no task ID");
    const report = await runBaseline(service);
    printChecks(report);
    return 0; // Starting health is evidence, not a task regression.
  }
  if (action === "list") {
    if (positionals.length > 1) throw new Error("checks list takes at most one task ID");
    printChecks(await checkReport(service, positionals[0]));
    return 0;
  }
  if (action === "history") {
    if (positionals.length !== 1) throw new Error("checks history needs one check ID");
    const state = await service.detail();
    const check = state.checks[positionals[0]];
    if (!check) throw new Error(`Unknown check: ${positionals[0]}`);
    console.log(JSON.stringify({ id: positionals[0], history: check.history ?? [{ revision: check.revision, value: check.value }], results: check.results ?? [] }, null, 2));
    return 0;
  }
  if (action === "add") {
    if (positionals.length !== 1 || !option(options, "command") && !option(options, "procedure")) throw new Error("checks add needs a task ID and --command or --procedure");
    const timeoutSeconds = Number(option(options, "timeout-seconds") ?? "600");
    const result = await service.execute({ version: 1, kind: "check.put", expectedRevision: await service.revision(), payload: {
      ...(option(options, "id") ? { id: option(options, "id") } : {}), taskId: positionals[0],
      ...(option(options, "command") ? { command: option(options, "command") } : { procedure: option(options, "procedure") }),
      phase: option(options, "phase") ?? (option(options, "procedure") ? "review" : "task"),
      cwd: option(options, "cwd") ?? ".", timeoutSeconds, expected: option(options, "expected") ?? "exit 0",
      ...(option(options, "criterion") ? { criterion: option(options, "criterion") } : {}),
    } });
    console.log(`Check ${result.subjectId} saved at revision ${result.revision}`);
    return 0;
  }
  if (action === "run") {
    if (positionals.length !== 1 && !(positionals.length === 2 && positionals[0] === "task")) throw new Error("checks run needs a check ID or task TASK-001");
    const state = await service.detail();
    const ids = positionals[0] === "task" ? Object.entries(state.checks).filter(([, check]) => check.value.taskId === positionals[1] && check.value.command && (check.value.planRevision === undefined || check.value.planRevision === state.plan.revision)).map(([id]) => id) : [positionals[0]];
    const outcomes = [];
    for (const id of ids) { const result = await runCheck(service, id); outcomes.push(result.status); console.log(`${id}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`); }
    const report = await checkReport(service, positionals[0] === "task" ? positionals[1] : undefined);
    printChecks(report);
    return outcomes.some((status) => status === "fail" || status === "missing") || positionals[0] === "task" && report.rows.some((row) => row.taskId === positionals[1] && row.status === "missing") ? 1 : 0;
  }
  if (action === "skip" || action === "review") {
    if (positionals.length !== 1) throw new Error(`checks ${action} needs a check ID`);
    const state = await service.detail();
    const check = state.checks[positionals[0]];
    if (!check) throw new Error(`Unknown check: ${positionals[0]}`);
    if (action === "review" && !check.value.procedure) throw new Error("Only a review check can receive human review");
    await service.execute({ version: 1, kind: "check.result", expectedRevision: state.revision, payload: { id: positionals[0], checkRevision: check.revision,
      status: action === "skip" ? "skipped" : "pass", ...(action === "skip" ? { reason: option(options, "reason") } : { reviewer: option(options, "reviewer") }) } });
    console.log(`${positionals[0]}: ${action === "skip" ? "skipped" : "passed by reviewer"}`);
    return 0;
  }
  throw new Error("Use orch checks baseline|list|history|add|run|skip|review|approve");
}

async function actions(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  const { positionals, options } = parseArguments(rest, ["project", "base-revision", "id"]);
  const service = new CommandService(resolve(option(options, "project") ?? process.cwd()));
  const state = await service.detail();
  if (operation === "request") {
    if (positionals.length !== 3 || !["merge", "deployment"].includes(positionals[0])) throw new Error("actions request needs merge|deployment, destination, and artifact revision");
    const result = await service.execute({ version: 1, kind: "action.request", expectedRevision: state.revision,
      payload: { target: positionals[0], destination: positionals[1], artifactRevision: positionals[2],
        ...(option(options, "base-revision") ? { baseRevision: option(options, "base-revision") } : {}),
        ...(option(options, "id") ? { id: option(options, "id") } : {}) } });
    const updated = await service.detail();
    console.log(`Action ${result.subjectId} revision ${updated.actions[result.subjectId].revision} paused for approval`);
    return;
  }
  if (positionals.length !== 1 || !state.actions[positionals[0]]) throw new Error("actions show|approve|ready needs an existing action ID");
  const id = positionals[0];
  const action = state.actions[id];
  if (operation === "approve") {
    await service.execute({ version: 1, kind: "approval.grant", expectedRevision: state.revision,
      payload: { target: action.value.target, targetRevision: action.revision, actionId: id, actor: "user" } });
  } else if (operation === "ready") {
    await service.requireActionApproval(id);
  } else if (operation !== "show") throw new Error("Use orch actions request|show|approve|ready");
  const updated = await service.detail();
  let gate = actionGate(updated, id);
  if (!gate) try { await service.requireActionApproval(id); }
  catch (error) { gate = error instanceof Error ? error.message : String(error); }
  console.log(JSON.stringify({ id, revision: updated.actions[id].revision, ...updated.actions[id].value,
    gate: gate ?? null }, null, 2));
}

async function worktrees(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  const { positionals, options } = parseArguments(rest, ["project", "check"]);
  const project = resolve(option(options, "project") ?? process.cwd());
  const service = new CommandService(project);
  if (operation === "base") {
    if (positionals.length !== 2 || option(options, "check")) throw new Error("worktrees base needs a branch and exact commit");
    await service.execute({ version: 1, kind: "worktree.base", expectedRevision: await service.revision(),
      payload: { branch: positionals[0], commit: positionals[1], actor: "user" } });
    console.log(`Approved worktree base: ${positionals[0]} ${positionals[1]}`);
    return;
  }
  const manager = await new WorktreeManager(project).load();
  if (operation === "show") {
    if (positionals.length || option(options, "check")) throw new Error("worktrees show takes no task IDs");
    console.log(JSON.stringify({ base: (await service.detail()).worktreeBase ?? null, ...await manager.detail() }, null, 2));
  } else if (operation === "integrate") {
    if (positionals.length !== 1 || !option(options, "check")) throw new Error("worktrees integrate needs comma-separated task IDs and --check");
    const result = await manager.integrate(positionals[0].split(","), option(options, "check")!);
    console.log(JSON.stringify(result, null, 2));
  } else if (operation === "verify") {
    if (positionals.length !== 1 || !option(options, "check")) throw new Error("worktrees verify needs one integration ID and --check");
    const result = await manager.verifyIntegration(positionals[0], option(options, "check")!);
    console.log(JSON.stringify(result, null, 2));
  } else if (operation === "merge") {
    if (positionals.length !== 1 || option(options, "check")) throw new Error("worktrees merge needs one approved action ID");
    const result = await manager.merge(positionals[0]);
    console.log(`Merged ${result.commit} into ${result.target}`);
  } else throw new Error("Use orch worktrees base|show|integrate|verify|merge");
}

function printChecks(report: Awaited<ReturnType<typeof checkReport>>): void {
  for (const row of report.rows) console.log(`${row.status.padEnd(7)} ${row.phase.padEnd(11)} ${row.taskId ?? "project"} ${row.id} ${row.criterion ?? row.command ?? row.procedure ?? row.expected}`);
  console.log(`pass ${report.counts.pass}; fail ${report.counts.fail}; skipped ${report.counts.skipped}; missing ${report.counts.missing}; unrun ${report.counts.unrun}`);
}

async function status(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["project"]);
  if (positionals.length) throw new Error("status does not accept positional arguments");
  const graph = await loadGraph(resolve(option(options, "project") ?? process.cwd()));
  const records = graph.snapshot().tasks;
  const project = resolve(option(options, "project") ?? process.cwd());
  const detail = await new CommandService(project).detail();
  const workers = detail.plan.value.draft ? (await (await new WorktreeManager(project).load()).detail()).workers : {};
  if (!records.length) {
    console.log("No tasks planned. Use orch plan to add one.");
    return;
  }
  for (const record of records) {
    console.log(`${record.spec.id}  ${graph.status(record.spec.id)}  ${record.spec.description}  (${record.attempts.length} attempts)`);
    if (record.status === "completed" && detail.plan.value.draft) {
      const gate = taskVerificationGate(detail, record.spec.id, workers[record.spec.id]);
      console.log(gate ? `  Worker output complete; verification pending: ${gate}` : "  Criterion checks and named reviews passed; integration pending");
    }
    if (record.status === "failed" && record.failureReason) console.log(`  Reason: ${record.failureReason}`);
  }
  const signal = await readCapacity(resolve(option(options, "project") ?? process.cwd()));
  console.log(`Codex capacity: ${capacityAvailability(signal) === "known" ? `${signal!.remainingTokens} measured tokens at ${signal!.observedAt}` : "unknown"}`);
}

async function capacity(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["project"]);
  if (positionals.length) throw new Error("capacity does not accept positional arguments");
  const signal = await readCapacity(resolve(option(options, "project") ?? process.cwd()));
  console.log(JSON.stringify({ availability: capacityAvailability(signal), ...(signal ? { signal } : {}) }, null, 2));
}

async function retry(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["project", "preserve", "discard"]);
  if (positionals.length !== 1) throw new Error("retry needs one task ID");
  if (options.preserve && options.discard) throw new Error("Choose either --preserve or --discard");
  const project = resolve(option(options, "project") ?? process.cwd());
  const service = new CommandService(project);
  await service.execute({ version: 1, kind: "plan.retry", expectedRevision: await service.revision(),
    payload: { taskId: positionals[0], ...(options.preserve ? { reconciliation: "preserve" } : options.discard ? { reconciliation: "discard" } : {}) } });
  console.log(`${positionals[0]} reset to pending.`);
}

async function run(args: string[]): Promise<number> {
  const { options } = parseArguments(args, ["project", "executor", "check", "once", "timeout-seconds", "resume"]);
  const project = resolve(option(options, "project") ?? process.cwd());
  const lockPath = join(project, ".orch", "run.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try { handle = await open(lockPath, "wx"); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    const priorPid = Number((await readFile(lockPath, "utf8")).trim());
    if (!Number.isSafeInteger(priorPid) || priorPid < 1) throw new Error("Run lock is invalid; inspect it before retrying");
    try { process.kill(priorPid, 0); throw new Error(`Another run is active (PID ${priorPid})`); }
    catch (probe) { if (!(probe && typeof probe === "object" && "code" in probe && probe.code === "ESRCH")) throw probe; }
    await rm(lockPath);
    handle = await open(lockPath, "wx");
  }
  try {
    await handle.writeFile(String(process.pid));
    await handle.sync();
    return await runUnlocked(args);
  } finally {
    await handle.close();
    if ((await readFile(lockPath, "utf8").catch(() => "")).trim() === String(process.pid)) await rm(lockPath, { force: true });
  }
}

async function runUnlocked(args: string[]): Promise<number> {
  const { positionals, options } = parseArguments(args, ["project", "executor", "check", "once", "timeout-seconds", "resume"]);
  if (positionals.length) throw new Error("run does not accept positional arguments");
  const project = resolve(option(options, "project") ?? process.cwd());
  const commands = new CommandService(project);
  const planning = await commands.detail();
  const resumeId = option(options, "resume");
  const prior = resumeId ? planning.runs[resumeId] : undefined;
  if (resumeId && (!prior || !["paused", "running"].includes(prior.value.status))) throw new Error("Run ID is not paused or interrupted");
  const mode = oneOf(option(options, "executor") ?? (prior?.value.mode === "live" ? "codex" : undefined), ["fake", "codex"] as const, "fake", "executor");
  if (prior && prior.value.mode !== (mode === "fake" ? "simulated" : "live")) throw new Error("Resume must use the original executor mode");
  const priorEvents = resumeId ? (await readRunEvents(project)).filter((event) => event.runId === resumeId) : [];
  const events = new RunEventWriter(project, resumeId, priorEvents.at(-1)?.sequence ?? 0);
  if (resumeId && prior?.value.status === "running") {
    await commands.execute({ version: 1, kind: "run.record", expectedRevision: await commands.revision(),
      payload: { runId: resumeId, status: "paused", mode: mode === "fake" ? "simulated" : "live", reason: "Previous run was interrupted" } });
    await events.append({ type: "run.paused", reason: "Previous run was interrupted" });
  }
  const gate = executionGate(planning);
  if (gate) {
    if (!resumeId) {
      const paused = await commands.execute({ version: 1, kind: "run.record", expectedRevision: planning.revision,
        payload: { runId: randomUUID(), status: "paused", mode: mode === "fake" ? "simulated" : "live" } });
      console.log(`Run ${paused.subjectId} paused: ${gate}`);
    } else console.log(`Run ${resumeId} remains paused: ${gate}`);
    return 0;
  }
  const graph = await loadGraph(project);
  const unfinished = graph.snapshot().tasks.filter((record) => record.status === "running");
  if (unfinished.length && !resumeId) throw new Error(`Tasks still marked running: ${unfinished.map((record) => record.spec.id).join(", ")}. Inspect changes and use orch retry after the prior process stops.`);
  const timeoutMs = parseTimeout(option(options, "timeout-seconds"), 600);
  if (mode === "codex" && !option(options, "check")?.trim()) {
    throw new Error("Live Codex runs require --check with a project validation command");
  }
  if (mode === "codex") {
    const baseGate = worktreeBaseGate(planning);
    if (baseGate) throw new Error(baseGate);
    const preflight = await executionPreflight(project, "live", option(options, "check"));
    if (preflight.blockers.length) throw new Error(preflight.blockers.join("; "));
  }
  const knowledge = new KnowledgeStore(project);
  const registry = await loadRegistry(project);
  const policyVersion = Math.max(registry.policyVersion ?? 1, planning.policy.revision);
  const startedPolicy = priorEvents.find((event) => event.type === "run.started");
  if (mode === "codex" && startedPolicy?.type === "run.started" && startedPolicy.policyVersion !== policyVersion)
    throw new Error("Routing policy changed since this run started; start a new run with the current policy");
  const routing = planning.policy.value.routing ?? { limits: {}, rules: {} };
  const observed = mode === "codex" ? (await knowledge.list("project")).filter((entry) => entry.kind === "attempt") : [];
  let prices: PriceSnapshot | undefined;
  try { prices = JSON.parse(await readFile(join(project, ".orch", "prices.json"), "utf8")) as PriceSnapshot; }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
  const resolved = (task: TaskSpec, route: Route, attempt: number) => resolveRoute(task, route, attempt, routing, registry, observed, prices);
  const scheduler = mode === "codex" ? await CapacityScheduler.load(project, registry, (task) => resolved(task, routeTask(task), 1).profile,
    routing.limits.maxCostPerTaskUsd) : undefined;
  if (unfinished.length) {
    const workers = mode === "codex" ? (await new WorktreeManager(project).load()).detail() : undefined;
    const records = workers ? (await workers).workers : {};
    for (const record of unfinished) {
      const worker = records[record.spec.id];
      if (worker?.validation?.passed) throw new Error(`Task ${record.spec.id} has validated worktree output; inspect and reconcile it before retry`);
      if (worker && !(await stat(worker.path).then((item) => item.isDirectory(), () => false)))
        throw new Error(`Task ${record.spec.id} worktree is missing; inspect before retry`);
      if (worker) throw new Error(`Task ${record.spec.id} has interrupted worktree output at ${worker.path}. Inspect changes, then use orch retry ${record.spec.id} --preserve or --discard after its worker stops`);
    }
    for (const record of unfinished) {
      graph.retry(record.spec.id);
      await events.append({ type: "task.interrupted", taskId: record.spec.id, reason: "Previous worker stopped before a worktree was recorded" });
    }
    await saveSnapshot(project, graph.snapshot());
  }
  const selectedLessons = new Map<string, SelectedLesson[]>();
  const recordedSelections = new Set<string>();
  const executor = mode === "fake"
    ? new FakeExecutor()
    : new WorktreeCodexExecutor(await new WorktreeManager(project).load(), registry, option(options, "check") ?? "", (task) => ({
      ids: (selectedLessons.get(task.id) ?? []).map(({ entry }) => entry.id),
      text: (selectedLessons.get(task.id) ?? []).map(({ entry }) => `[${entry.scope}] ${entry.text.slice(0, 500)}`),
    }), timeoutMs,
    async (task) => {
      if (recordedSelections.has(task.id)) return;
      const selected = selectedLessons.get(task.id) ?? [];
      await events.append({ type: "knowledge.selected", taskId: task.id,
        lessonIds: selected.map(({ entry }) => entry.id),
        selections: selected.map(({ entry, reason }) => ({ id: entry.id, scope: entry.scope, reason })) });
      recordedSelections.add(task.id);
    }, (task) => {
      const drafted = planning.plan.value.draft?.tasks.find((item) => item.id === task.id);
      return drafted ? [`Acceptance criteria: ${drafted.acceptanceCriteria.join("; ")}.`,
        `Relevant areas: ${drafted.areas.join(", ")}.`, `Required context: ${drafted.context.join(", ")}.`] : [];
    }, (task, route, attempt) => resolved(task, route, attempt).profile);
  await ensureProjectIgnore(project);
  await commands.execute({ version: 1, kind: "run.record", expectedRevision: await commands.revision(),
    payload: { runId: events.runId, status: "running", mode: mode === "fake" ? "simulated" : "live" } });
  await events.append(priorEvents.some((event) => event.type === "run.started") ? { type: "run.resumed" } : { type: "run.started", mode: mode === "fake" ? "simulated" : "live", tasks: graph.snapshot().tasks, policyVersion });
  console.log(`Run ID: ${events.runId}`);
  console.log(mode === "fake" ? "Running with fake workers; project code will not be changed." : "Running live Codex tasks in isolated Git worktrees.");
  const recorded = new Map(graph.snapshot().tasks.map((record) => [record.spec.id, record.attempts.length]));
  const result = await orchestrate(graph, executor, async (snapshot) => {
    await saveSnapshot(project, snapshot);
    for (const record of snapshot.tasks) {
      const start = recorded.get(record.spec.id) ?? 0;
      for (const attempt of record.attempts.slice(start)) {
        await knowledge.recordAttempt("project", record.spec, attempt, mode === "fake", events.runId);
      }
      recorded.set(record.spec.id, record.attempts.length);
    }
  }, {
    maxTasks: options.once === true ? 1 : undefined,
    capacity: scheduler ? (task, inFlight) => scheduler.decide(task, inFlight) : undefined,
    beforeTask: async (task) => {
      const current = await commands.detail();
      if (mode === "codex" && current.policy.revision !== planning.policy.revision) return "Routing policy changed; resume with the current version";
      if (mode !== "codex") return executionGate(current);
      const gate = worktreeBaseGate(current);
      if (gate) return gate;
      if (current.plan.value.draft && task.dependsOn.length) {
        const workers = (await (await new WorktreeManager(project).load()).detail()).workers;
        for (const id of task.dependsOn) {
          const pending = taskVerificationGate(current, id, workers[id]);
          if (pending) return `Dependency verification pending: ${pending}. Record review and resume this run`;
        }
      }
      return undefined;
    },
    initialRoute: mode === "codex" ? (task) => resolved(task, routeTask(task), 1).route : undefined,
    retryRoute: mode === "codex" ? (task, initial, failed) => {
      const established = routeTask(task);
      return initial.label !== established.label ? (failed === 1 ? established : null) : nextRoute(initial, failed);
    } : undefined,
    onEvent: async (event) => {
      await events.append(event);
      if (mode === "codex" && event.type === "task.started") {
        const task = graph.get(event.taskId).spec;
        selectedLessons.set(task.id, await knowledge.retrieve(task));
      }
    }, simulated: mode === "fake",
    routeDecision: (task, route, attempt) => {
      const rule = routing.rules[`${task.type}:${task.difficulty}:${task.risk}`];
      const evidenceRevision = rule && attempt === 1 ? (planning.policy.value.history ?? []).slice().reverse().find((item) =>
        item.cause === "live-outcomes" && item.candidate?.alias === rule.alias && item.baseline?.alias === rule.fallbackAlias) : undefined;
      const candidates = registry.models.filter((model) => model.provider === "codex" && model.enabled && model.tier === route.label)
        .sort((a, b) => b.weight - a.weight || a.alias.localeCompare(b.alias));
      let chosen: ModelProfile | undefined;
      let fallbackAlias: string | undefined;
      let constraint: string | undefined;
      if (mode === "codex") {
        try { const decision = resolved(task, route, attempt); chosen = decision.profile; fallbackAlias = decision.fallbackAlias; constraint = decision.constraint; }
        catch { /* The attempt records the provider error. */ }
      }
      return {
        type: "route.decided", taskId: task.id, attempt, route,
        reason: evidenceRevision?.reason ?? routeReason(task), policyVersion,
        candidates: candidates.map((model) => ({ alias: model.alias, model: model.model, weight: model.weight })),
        ...(chosen ? { chosenAlias: chosen.alias, chosenModel: `${chosen.provider}:${chosen.model}`, preferenceWeight: chosen.weight } : {}),
        ...(fallbackAlias ? { fallbackAlias } : {}), ...(constraint ? { constraint } : {}),
        userLimits: routing.limits,
        observedEvidenceIds: evidenceRevision?.evidenceIds ?? [],
      };
    },
  });
  const finalGate = result.paused ?? (mode === "codex" ? worktreeBaseGate(await commands.detail()) : executionGate(await commands.detail()));
  if (finalGate) {
    await commands.execute({ version: 1, kind: "run.record", expectedRevision: await commands.revision(),
      payload: { runId: events.runId, status: "paused", mode: mode === "fake" ? "simulated" : "live", reason: finalGate } });
    await events.append({ type: "run.paused", reason: finalGate });
    console.log(`Run ${events.runId} paused: ${finalGate}`);
    return 0;
  }
  await events.append({ type: "run.finished", blocked: result.blocked });
  await commands.execute({ version: 1, kind: "run.record", expectedRevision: await commands.revision(),
    payload: { runId: events.runId, status: "finished", mode: mode === "fake" ? "simulated" : "live" } });
  for (const [index, batch] of result.batches.entries()) {
    console.log(`Batch ${index + 1}: ${batch.join(" + ")}`);
  }
  if (executor instanceof FakeExecutor) {
    for (const call of executor.calls) console.log(`${call.taskId}: fake ${call.route} attempt ${call.attempt}`);
  }
  for (const record of result.snapshot.tasks) {
    console.log(`${record.spec.id}: ${record.status}`);
    if (record.status === "completed" && mode === "codex" && planning.plan.value.draft) {
      const state = await commands.detail();
      const worker = (await (await new WorktreeManager(project).load()).detail()).workers[record.spec.id];
      const gate = taskVerificationGate(state, record.spec.id, worker);
      console.log(gate ? `  Worker output complete; verification pending: ${gate}` : "  Criterion checks and named reviews passed; integration pending");
    }
    if (record.status === "failed" && record.failureReason) console.log(`  Reason: ${record.failureReason}`);
  }
  if (result.blocked.length) console.log(`Blocked: ${result.blocked.join(", ")}`);
  const failed = result.snapshot.tasks.some((record) => record.status === "failed");
  return failed || (options.once !== true && result.blocked.length > 0) ? 1 : 0;
}

function parseTimeout(value: string | undefined, fallbackSeconds: number): number {
  const seconds = value === undefined ? fallbackSeconds : Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("--timeout-seconds must be an integer from 1 to 3600");
  }
  return seconds * 1000;
}

async function doctor(args: string[]): Promise<number> {
  const [provider, ...rest] = args;
  if (provider !== "codex") throw new Error("Use orch doctor codex");
  const { positionals, options } = parseArguments(rest, ["project", "timeout-seconds"]);
  if (positionals.length) throw new Error("doctor codex takes no positional arguments");
  const project = resolve(option(options, "project") ?? process.cwd());
  await loadGraph(project);
  const timeoutMs = parseTimeout(option(options, "timeout-seconds"), 60);
  const result = await smokeCodex(project, await loadRegistry(project), timeoutMs);
  if (!result.ok) throw new Error(result.reason);
  console.log(`Codex connection passed with ${result.model}.`);
  return 0;
}

async function models(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const allowed = action === "add" ? ["project", "provider", "model", "tier", "effort", "weight", "enable"]
    : action === "recommend" ? ["project", "prices", "manual-alias"]
      : action === "limits" ? ["project", "file", "reason"]
        : action === "rollback" ? ["project", "reason"] : ["project"];
  const { positionals, options } = parseArguments(rest, allowed);
  const project = resolve(option(options, "project") ?? process.cwd());
  await loadGraph(project);
  const registry = await loadRegistry(project);
  if (action === "policy") {
    if (positionals.length) throw new Error("models policy takes no arguments");
    const policy = (await new CommandService(project).detail()).policy;
    console.log(JSON.stringify({ version: policy.revision, routing: policy.value.routing ?? { limits: {}, rules: {} }, history: policy.value.history ?? [] }, null, 2));
    return;
  }
  if (action === "limits" || action === "apply" || action === "rollback") {
    const service = new CommandService(project);
    let kind: Command["kind"];
    let payload: Record<string, unknown>;
    if (action === "limits") {
      if (positionals.length || !option(options, "file")) throw new Error("models limits needs --file");
      kind = "policy.limits";
      payload = { actor: "user", limits: JSON.parse(await readFile(resolve(option(options, "file")!), "utf8")), reason: option(options, "reason") ?? "User routing limits" };
    } else if (action === "apply") {
      if (positionals.length !== 1) throw new Error("models apply needs one task ID");
      kind = "policy.route"; payload = { taskId: positionals[0] };
    } else {
      if (positionals.length !== 1) throw new Error("models rollback needs a version");
      kind = "policy.rollback"; payload = { targetVersion: Number(positionals[0]), actor: "user", reason: option(options, "reason") ?? `Restore routing version ${positionals[0]}` };
    }
    await service.execute({ version: 1, kind, expectedRevision: await service.revision(), payload });
    const policy = (await service.detail()).policy;
    console.log(JSON.stringify({ version: policy.revision, routing: policy.value.routing, revision: policy.value.history?.at(-1) }, null, 2));
    return;
  }
  if (action === "recommend") {
    if (positionals.length !== 1) throw new Error("models recommend needs one task ID");
    const task = (await loadGraph(project)).snapshot().tasks.find((record) => record.spec.id === positionals[0])?.spec;
    if (!task) throw new Error(`Unknown task: ${positionals[0]}`);
    const priceFile = option(options, "prices");
    const prices = priceFile ? JSON.parse(await readFile(resolve(priceFile), "utf8")) as PriceSnapshot : undefined;
    const attempts = (await new KnowledgeStore(project).list("project")).filter((entry) => entry.kind === "attempt");
    const proposal = recommendModelRoute({ task, registry, attempts, prices,
      manualAlias: option(options, "manual-alias") });
    const routing = (await new CommandService(project).detail()).policy.value.routing ?? { limits: {}, rules: {} };
    console.log(JSON.stringify(constrainProposal(proposal, task, routing, registry, attempts, prices), null, 2));
    return;
  }
  if (action === "list") {
    if (positionals.length) throw new Error("models list takes no aliases");
    for (const item of registry.models) console.log(`${item.alias}  ${item.provider}  ${item.model || "unconfigured"}  ${item.tier}  ${item.effort}  ${item.enabled ? "enabled" : "disabled"}  weight=${item.weight}`);
    return;
  }
  if (action === "add") {
    if (positionals.length !== 1) throw new Error("models add needs one alias");
    if (registry.models.some((item) => item.alias === positionals[0])) throw new Error(`Model alias already exists: ${positionals[0]}`);
    const provider = oneOf(option(options, "provider"), ["codex", "claude"] as const, "codex", "provider") as ProviderId;
    const tier = option(options, "tier");
    const effort = option(options, "effort");
    if (!tier || !effort) throw new Error("models add requires --tier and --effort");
    const item: ModelProfile = {
      alias: positionals[0], provider, model: option(options, "model") ?? "",
      tier: tier as ModelProfile["tier"], effort: effort as ModelProfile["effort"],
      enabled: options.enable === true, weight: Number(option(options, "weight") ?? "1"),
    };
    validateProfile(item);
    const service = new CommandService(project);
    await service.execute({ version: 1, kind: "policy.model", expectedRevision: await service.revision(), payload: { action, alias: item.alias, model: item } });
  } else if (action === "enable" || action === "disable" || action === "weight") {
    if (positionals.length !== (action === "weight" ? 2 : 1)) throw new Error(`models ${action} needs an alias${action === "weight" ? " and value" : ""}`);
    const item = registry.models.find((model) => model.alias === positionals[0]);
    if (!item) throw new Error(`Unknown model alias: ${positionals[0]}`);
    const service = new CommandService(project);
    await service.execute({ version: 1, kind: "policy.model", expectedRevision: await service.revision(),
      payload: { action, alias: item.alias, ...(action === "weight" ? { weight: positionals[1] } : {}) } });
  } else {
    throw new Error("Use orch models list|add|enable|disable|weight|recommend|limits|apply|policy|rollback");
  }
  console.log("Updated model registry.");
}

async function knowledge(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const allowed = action === "add" ? ["scope", "project", "type"]
    : action === "review" ? ["project", "status"]
    : action === "export" ? ["project", "scope", "output"]
    : action === "list" || action === "remove" ? ["scope", "project"] : ["project"];
  const { positionals, options } = parseArguments(rest, allowed);
  const project = resolve(option(options, "project") ?? process.cwd());
  await loadGraph(project);
  await ensureProjectIgnore(project);
  const scope = oneOf(option(options, "scope"), ["project", "global"] as const, "project", "scope") as KnowledgeScope;
  const store = new KnowledgeStore(project);
  if (action === "add") {
    if (scope !== "project") throw new Error("Add a project note, review it, then promote it to global knowledge");
    await store.note(scope, positionals.join(" "), oneOf(option(options, "type"), taskTypes, "other", "type"));
    console.log(`Saved ${scope} knowledge note.`);
  } else if (action === "list") {
    if (positionals.length) throw new Error("knowledge list takes no text");
    for (const entry of await store.list(scope)) {
      if (entry.kind === "note") console.log(`${entry.id}  ${entry.createdAt}  ${entry.reviewStatus}  note  ${entry.text}`);
      else if (entry.kind === "candidate") console.log(`${entry.id}  ${entry.createdAt}  ${entry.reviewStatus}  candidate  ${entry.text}  evidence=${entry.evidence.map((item) => `${item.runId}/${item.taskId}/${item.attemptId}`).join(",")}${entry.lessonId ? `  lesson=${entry.lessonId}` : ""}`);
      else console.log(`${entry.at}  ${entry.taskId}  ${entry.route}  ${entry.passed ? "passed" : "failed"}  ${entry.simulated ? "simulated" : entry.model ?? "live"}`);
    }
  } else if (action === "review") {
    if (positionals.length !== 1 || !option(options, "status")) throw new Error("knowledge review needs an ID and --status");
    const status = oneOf(option(options, "status"), ["pending", "approved", "rejected"] as const, "pending", "status");
    await store.review(positionals[0], status);
    console.log(`Reviewed ${positionals[0]}: ${status}`);
  } else if (action === "promote") {
    if (positionals.length !== 1) throw new Error("knowledge promote needs one project note ID");
    const entry = await store.promote(positionals[0]);
    console.log(`Promoted ${positionals[0]} as ${entry.id}`);
  } else if (action === "edit") {
    if (positionals.length < 2) throw new Error("knowledge edit needs an ID and new text");
    await store.edit(positionals[0], positionals.slice(1).join(" "));
    console.log(`Edited ${positionals[0]}; review is pending.`);
  } else if (action === "remove") {
    if (positionals.length !== 1) throw new Error("knowledge remove needs one ID");
    await store.remove(scope, positionals[0]);
    console.log(`Removed ${positionals[0]} from ${scope} knowledge.`);
  } else if (action === "export") {
    if (positionals.length) throw new Error("knowledge export takes no IDs");
    const data = `${JSON.stringify(await store.export(scope), null, 2)}\n`;
    const output = option(options, "output");
    if (output) {
      await writeFile(resolve(output), data, { encoding: "utf8", flag: "wx" });
      console.log(`Exported ${scope} knowledge to ${resolve(output)}`);
    } else console.log(data.trimEnd());
  } else throw new Error("Use orch knowledge add|list|review|promote|edit|remove|export");
}

async function history(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["project"]);
  if (positionals.length) throw new Error("history takes no positional arguments");
  const project = resolve(option(options, "project") ?? process.cwd());
  await loadGraph(project);
  await ensureProjectIgnore(project);
  const entries = await new KnowledgeStore(project).list("project");
  for (const entry of entries) {
    if (entry.kind !== "attempt") continue;
    console.log(`${entry.at}  ${entry.taskId}  ${entry.route}  ${entry.passed ? "passed" : "failed"}  ${entry.simulated ? "simulated" : "live"}  ${entry.model ?? "fake"}  tokens=${(entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)}`);
  }
}

async function serve(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["project", "port"]);
  if (positionals.length) throw new Error("serve does not accept positional arguments");
  const project = resolve(option(options, "project") ?? process.cwd());
  await mkdir(project, { recursive: true });
  const port = Number(option(options, "port") ?? "8765");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  const server = createLocalApi(project);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  console.log(`Local API: http://127.0.0.1:${port}/api/tasks`);
}

async function applyCommand(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["project", "json"]);
  if (positionals.length || !option(options, "json")) throw new Error("command needs --json with a versioned command");
  const project = resolve(option(options, "project") ?? process.cwd());
  const result = await new CommandService(project).execute(JSON.parse(option(options, "json")!) as Command);
  console.log(JSON.stringify(result));
}

async function shared(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "neon") {
    const [operation, ...cloudArgs] = rest;
    const { positionals, options } = parseArguments(cloudArgs, ["project", "environment", "env-file"]);
    if (positionals.length || !["migrate", "sync", "runs", "status", "diagnose"].includes(operation) ||
        !["development", "production"].includes(option(options, "environment") ?? ""))
      throw new Error("Use shared neon status|diagnose|sync|runs|migrate --environment development|production [--env-file path] [--project directory]");
    const environment = option(options, "environment") as NeonEnvironment;
    const env = option(options, "env-file") ? await neonEnvironmentFile(option(options, "env-file")!) : process.env;
    const project = resolve(option(options, "project") ?? process.cwd());
    const storage = new StorageService(project, env);
    if (operation === "status" || operation === "diagnose" || operation === "sync") {
      console.log(JSON.stringify(await (operation === "status" ? storage.status(environment) : operation === "diagnose"
        ? storage.diagnose(environment) : storage.sync(environment))));
      return;
    }
    const database = new NeonMetadata(neonConfig(environment, env));
    if (operation === "migrate") { await database.migrate(); console.log(`Neon ${environment} schema migrated`); return; }
    const snapshot = await localSharedSnapshot(project);
    console.log(JSON.stringify(await database.runs(snapshot.projectId)));
    return;
  }
  const { positionals, options } = parseArguments(rest, ["project"]);
  if (positionals.length || !["migrate", "sync", "runs"].includes(action)) throw new Error("Use shared migrate|sync|runs [--project directory]");
  const database = new PostgresMetadata();
  if (action === "migrate") { await database.migrate(); console.log("Shared metadata schema migrated"); return; }
  const project = resolve(option(options, "project") ?? process.cwd());
  const snapshot = await localSharedSnapshot(project);
  if (action === "sync") { await database.migrate(); await database.sync(snapshot); console.log(`Synced ${snapshot.runs.length} runs for ${snapshot.projectId}`); }
  else console.log(JSON.stringify(await database.runs(snapshot.projectId)));
}

async function installSkill(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["to", "force"]);
  if (positionals.length) throw new Error("skill install does not accept positional arguments");
  const source = resolve(__dirname, "..", "skills", "orch", "SKILL.md");
  const root = resolve(option(options, "to") ?? join(homedir(), ".agents", "skills"));
  const target = join(root, "orch", "SKILL.md");
  const content = await readFile(source, "utf8");
  try {
    const existing = await readFile(target, "utf8");
    if (existing === content) {
      console.log(`Skill already current: ${target}`);
      return;
    }
    if (options.force !== true) throw new Error(`Skill already exists at ${target}; use --force to replace it`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log(`Installed Codex skill: ${target}`);
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      return 0;
    case "init":
      await init(rest);
      return 0;
    case "plan":
      await plan(rest);
      return 0;
    case "draft":
      await draft(rest);
      return 0;
    case "checks":
      return checks(rest);
    case "status":
      await status(rest);
      return 0;
    case "preflight": {
      const { positionals, options } = parseArguments(rest, ["project", "executor", "check"]);
      if (positionals.length) throw new Error("preflight does not accept positional arguments");
      const mode = oneOf(option(options, "executor"), ["fake", "codex"] as const, "fake", "executor");
      console.log(JSON.stringify(await executionPreflight(resolve(option(options, "project") ?? process.cwd()),
        mode === "codex" ? "live" : "simulated", option(options, "check")), null, 2));
      return 0;
    }
    case "capacity":
      await capacity(rest);
      return 0;
    case "retry":
      await retry(rest);
      return 0;
    case "run":
      return run(rest);
    case "actions":
      await actions(rest);
      return 0;
    case "worktrees":
      await worktrees(rest);
      return 0;
    case "doctor":
      return doctor(rest);
    case "models":
      await models(rest);
      return 0;
    case "knowledge":
      await knowledge(rest);
      return 0;
    case "history":
      await history(rest);
      return 0;
    case "serve":
      await serve(rest);
      return 0;
    case "command":
      await applyCommand(rest);
      return 0;
    case "shared":
      await shared(rest);
      return 0;
    case "skill":
      if (rest[0] !== "install") throw new Error("Use orch skill install");
      await installSkill(rest.slice(1));
      return 0;
    default:
      throw new Error(`Unknown command: ${command}. Run orch help.`);
  }
}

main(process.argv.slice(2)).then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    console.error(`orch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
