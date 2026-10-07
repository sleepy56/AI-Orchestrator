import { CommandService } from "./command-service";
import { readRunEvents, RunEvent, summarizeRuns } from "./run-events";

export interface SharedAttempt {
  taskId: string;
  attempt: number;
  route: string;
  passed: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}
export interface SharedTask {
  taskId: string;
  category: string;
  risk: string;
  status: string;
  dependsOn: string[];
}
export interface SharedRun {
  runId: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  lastSequence: number;
  policyVersion: number;
  tasks: SharedTask[];
  attempts: SharedAttempt[];
}
export interface SharedSnapshot { version: 1; projectId: string; runs: SharedRun[] }

function record(value: unknown, allowed: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) if (!allowed.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
  return fields;
}
function oneOf(value: unknown, choices: readonly string[], name: string): string {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function count(value: unknown, name: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0) || (value as number) > 2147483647) throw new Error(`Invalid ${name}`);
  return value as number;
}
function time(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${name}`);
  return value;
}
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined { return value === undefined ? undefined : parse(value); }

// Validate the complete inbound object before opening a database connection. No record spreading or free-form JSON columns.
export function validateSharedSnapshot(value: unknown): SharedSnapshot {
  const top = record(value, ["version", "projectId", "runs"], "snapshot");
  if (top.version !== 1 || !Array.isArray(top.runs)) throw new Error("Invalid shared snapshot");
  const projectId = uuid(top.projectId, "project ID");
  const runs = top.runs.map((item): SharedRun => {
    const run = record(item, ["runId", "mode", "status", "startedAt", "finishedAt", "lastSequence", "policyVersion", "tasks", "attempts"], "run");
    if (!Array.isArray(run.tasks) || !Array.isArray(run.attempts)) throw new Error("Invalid run collections");
    const tasks = run.tasks.map((item): SharedTask => {
      const task = record(item, ["taskId", "category", "risk", "status", "dependsOn"], "task");
      if (!Array.isArray(task.dependsOn)) throw new Error("Invalid dependencies");
      return { taskId: id(task.taskId, "task ID"), category: oneOf(task.category, ["rename", "refactor", "analysis", "test", "other"], "category"),
        risk: oneOf(task.risk, ["low", "medium", "high", "critical"], "risk"),
        status: oneOf(task.status, ["pending", "running", "completed", "failed"], "task status"),
        dependsOn: task.dependsOn.map((dep) => id(dep, "dependency ID")) };
    });
    const taskIds = new Set(tasks.map((task) => task.taskId));
    if (taskIds.size !== tasks.length || tasks.some((task) => task.dependsOn.some((dep) => !taskIds.has(dep)))) throw new Error("Invalid shared task graph");
    const attempts = run.attempts.map((item): SharedAttempt => {
      const attempt = record(item, ["taskId", "attempt", "route", "passed", "model", "inputTokens", "outputTokens", "latencyMs"], "attempt");
      const taskId = id(attempt.taskId, "attempt task ID");
      if (!taskIds.has(taskId) || typeof attempt.passed !== "boolean") throw new Error("Invalid shared attempt");
      const model = optional(attempt.model, (value) => { if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) throw new Error("Invalid model"); return value; });
      return { taskId, attempt: count(attempt.attempt, "attempt number", true),
        route: oneOf(attempt.route, ["luna-low", "luna-medium", "luna-high", "luna-xhigh", "sol-low", "sol-medium", "sol-high", "sol-xhigh"], "route"),
        passed: attempt.passed,
        ...(model === undefined ? {} : { model }),
        ...(attempt.inputTokens === undefined ? {} : { inputTokens: count(attempt.inputTokens, "input tokens") }),
        ...(attempt.outputTokens === undefined ? {} : { outputTokens: count(attempt.outputTokens, "output tokens") }),
        ...(attempt.latencyMs === undefined ? {} : { latencyMs: count(attempt.latencyMs, "latency") }) };
    });
    if (new Set(attempts.map((attempt) => `${attempt.taskId}:${attempt.attempt}`)).size !== attempts.length) throw new Error("Duplicate shared attempt");
    const startedAt = time(run.startedAt, "start time");
    const finishedAt = optional(run.finishedAt, (value) => time(value, "finish time"));
    const status = oneOf(run.status, ["running", "paused", "finished"], "run status");
    if ((status === "finished") !== Boolean(finishedAt) || finishedAt && finishedAt < startedAt) throw new Error("Invalid run completion");
    return { runId: uuid(run.runId, "run ID"), mode: oneOf(run.mode, ["live", "simulated"], "run mode"), status, startedAt,
      ...(finishedAt ? { finishedAt } : {}), lastSequence: count(run.lastSequence, "sequence", true),
      policyVersion: count(run.policyVersion, "policy version"), tasks, attempts };
  });
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) throw new Error("Duplicate shared run");
  return { version: 1, projectId, runs };
}

export async function localSharedSnapshot(project: string): Promise<SharedSnapshot> {
  const [view, events] = await Promise.all([new CommandService(project).sharedView() as Promise<{ projectId: string }>, readRunEvents(project)]);
  const runs = summarizeRuns(events).map((summary): SharedRun => {
    const runEvents = events.filter((event) => event.runId === summary.runId);
    const start = runEvents.find((event): event is Extract<RunEvent, { type: "run.started" }> => event.type === "run.started");
    if (!start) throw new Error("Run has no start event");
    const statuses = new Map<string, string>();
    for (const event of runEvents) if (event.type === "task.started") statuses.set(event.taskId, "running");
    else if (event.type === "task.finished") statuses.set(event.taskId, event.status);
    return { runId: summary.runId, mode: summary.mode, status: summary.status, startedAt: summary.startedAt,
      ...(summary.finishedAt ? { finishedAt: summary.finishedAt } : {}), lastSequence: summary.lastSequence, policyVersion: start.policyVersion,
      tasks: start.tasks.map(({ spec, status }) => ({ taskId: spec.id, category: spec.type, risk: spec.risk, status: statuses.get(spec.id) ?? status, dependsOn: spec.dependsOn })),
      attempts: runEvents.filter((event): event is Extract<RunEvent, { type: "attempt.finished" }> => event.type === "attempt.finished")
        .map((event) => ({ taskId: event.taskId, attempt: event.attempt.attempt, route: event.attempt.route.label,
          passed: event.attempt.validation.passed,
          ...(event.attempt.model ? { model: event.attempt.model } : {}),
          ...(event.attempt.inputTokens === undefined ? {} : { inputTokens: event.attempt.inputTokens }),
          ...(event.attempt.outputTokens === undefined ? {} : { outputTokens: event.attempt.outputTokens }),
          ...(event.attempt.latencyMs === undefined ? {} : { latencyMs: event.attempt.latencyMs }) })) };
  });
  return validateSharedSnapshot({ version: 1, projectId: view.projectId, runs });
}
