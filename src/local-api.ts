import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KnowledgeStore } from "./knowledge";
import { PriceSnapshot, recommendModelRoute } from "./model-decisions";
import { loadRegistry } from "./models";
import { readRunEvents, summarizeRuns } from "./run-events";
import { TaskGraph } from "./scheduler";
import { TaskSnapshot } from "./types";
import { Command, CommandService } from "./command-service";
import { checkReport, runBaseline, runCheck } from "./checks";
import { PlanningWorkflow } from "./planning";
import { localSharedSnapshot } from "./shared-metadata";
import { constrainProposal } from "./routing-policy";
import { capacityAvailability, readCapacity } from "./capacity";
import { WorktreeManager } from "./worktrees";

interface WorkflowJob { id: string; startedAt: string; status: "running" | "finished" | "failed"; output: string; errorOutput: string; exitCode?: number | null }

function startRun(project: string, args: string[], jobs: Map<string, WorkflowJob>): WorkflowJob {
  for (const [id, previous] of jobs) if (jobs.size >= 20 && previous.status !== "running") jobs.delete(id);
  if (jobs.size >= 20) throw new Error("Too many active local run requests");
  const job: WorkflowJob = { id: randomUUID(), startedAt: new Date().toISOString(), status: "running", output: "", errorOutput: "" };
  jobs.set(job.id, job);
  const child = spawn(process.execPath, args, { cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => { job.output = (job.output + chunk.toString()).slice(-8192); });
  child.stderr.on("data", (chunk: Buffer) => { job.errorOutput = (job.errorOutput + chunk.toString()).slice(-8192); });
  child.on("error", (error: Error) => { job.status = "failed"; job.errorOutput = (job.errorOutput + error.message).slice(-8192); });
  child.on("close", (code: number | null) => { job.exitCode = code; job.status = code === 0 ? "finished" : "failed"; });
  return job;
}

function fields(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw new Error("Invalid workflow request");
  return body as Record<string, unknown>;
}
function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} required`);
  return value;
}

async function workflowAction(project: string, input: unknown, jobs: Map<string, WorkflowJob>): Promise<unknown> {
  const body = fields(input, ["operation", "mode", "once", "resume", "check", "timeoutSeconds", "taskIds", "integrationId", "actionId"]);
  const operation = required(body.operation, "Operation");
  if (operation === "run") {
    if (Object.keys(body).some((key) => !["operation", "mode", "once", "resume", "check", "timeoutSeconds"].includes(key))) throw new Error("Invalid run request");
    if (body.mode !== "fake" && body.mode !== "codex") throw new Error("Executor must be fake or codex");
    if (body.once !== undefined && typeof body.once !== "boolean") throw new Error("Invalid once value");
    const args = [join(__dirname, "cli.js"), "run", "--project", project, "--executor", body.mode];
    if (body.once) args.push("--once");
    if (body.resume !== undefined) args.push("--resume", required(body.resume, "Run ID"));
    if (body.check !== undefined) args.push("--check", required(body.check, "Validation command"));
    if (body.timeoutSeconds !== undefined) {
      if (!Number.isSafeInteger(body.timeoutSeconds) || (body.timeoutSeconds as number) < 1 || (body.timeoutSeconds as number) > 3600) throw new Error("Invalid timeout");
      args.push("--timeout-seconds", String(body.timeoutSeconds));
    }
    if (body.mode === "codex" && !body.check) throw new Error("Live runs require a validation command");
    return startRun(project, args, jobs);
  }
  const manager = await new WorktreeManager(project).load();
  if (operation === "integrate") {
    if (Object.keys(body).some((key) => !["operation", "taskIds", "check"].includes(key)) || !Array.isArray(body.taskIds) || !body.taskIds.length || body.taskIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))) throw new Error("Task IDs required");
    return manager.integrate(body.taskIds as string[], required(body.check, "Validation command"));
  }
  if (operation === "verify") {
    if (Object.keys(body).some((key) => !["operation", "integrationId", "check"].includes(key))) throw new Error("Invalid verify request");
    return manager.verifyIntegration(required(body.integrationId, "Integration ID"), required(body.check, "Validation command"));
  }
  if (operation === "merge") {
    if (Object.keys(body).some((key) => !["operation", "actionId"].includes(key))) throw new Error("Invalid merge request");
    return manager.merge(required(body.actionId, "Action ID"));
  }
  throw new Error("Unknown workflow operation");
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 65536) throw new Error("Command body too large");
  }
  return JSON.parse(body);
}

async function tasks(project: string) {
  const snapshot = JSON.parse(await readFile(join(project, ".orch", "tasks.json"), "utf8")) as TaskSnapshot;
  const graph = new TaskGraph(snapshot);
  return graph.snapshot().tasks.map((record) => ({ ...record, displayStatus: graph.status(record.spec.id) }));
}

async function priceSnapshot(project: string): Promise<PriceSnapshot | undefined> {
  try { return JSON.parse(await readFile(join(project, ".orch", "prices.json"), "utf8")) as PriceSnapshot; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function createLocalApi(project: string): Server {
  const jobs = new Map<string, WorkflowJob>();
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host ?? "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return json(response, 403, { error: "Local host required" });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== "http://127.0.0.1:5173" && origin !== "http://localhost:5173") {
      return json(response, 403, { error: "Local origin required" });
    }
    if (request.method === "POST" && request.url === "/api/commands") {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json(response, 415, { error: "JSON required" });
      try {
        const result = await new CommandService(project).execute(await requestBody(request) as Command);
        return json(response, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(response, /Stale revision/.test(message) ? 409 : 400, { error: message });
      }
    }
    if (request.method === "POST" && request.url === "/api/checks/baseline") {
      try { return json(response, 200, await runBaseline(new CommandService(project))); }
      catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (request.method === "POST" && request.url === "/api/checks/run") {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json(response, 415, { error: "JSON required" });
      try {
        const body = await requestBody(request) as { id?: string };
        if (!body || typeof body.id !== "string") throw new Error("Check ID required");
        return json(response, 200, await runCheck(new CommandService(project), body.id));
      } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (request.method === "POST" && (request.url === "/api/planning/start" || request.url === "/api/planning/answer")) {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json(response, 415, { error: "JSON required" });
      try {
        const body = await requestBody(request) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Planning request needs an object");
        const workflow = new PlanningWorkflow(project);
        const result = request.url.endsWith("/start")
          ? await workflow.start(body.goal as string)
          : await workflow.answer(body.answers as Record<string, string>, body.expectedRevision as number);
        return json(response, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(response, /Stale revision/.test(message) ? 409 : 400, { error: message });
      }
    }
    if (request.method === "POST" && request.url === "/api/project/register") {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json(response, 415, { error: "JSON required" });
      try {
        const body = await requestBody(request) as { documents?: string[] };
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "documents")) throw new Error("Registration accepts documents only");
        return json(response, 200, await new CommandService(project).register(body.documents));
      } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (request.method === "POST" && request.url === "/api/workflow") {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json(response, 415, { error: "JSON required" });
      try { return json(response, 200, await workflowAction(project, await requestBody(request), jobs)); }
      catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (request.method === "POST" && request.url === "/api/knowledge/action") {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") return json(response, 415, { error: "JSON required" });
      try {
        const body = fields(await requestBody(request), ["operation", "id", "status", "text", "taskCategory", "scope"]);
        await new CommandService(project).detail();
        const store = new KnowledgeStore(project);
        const operation = required(body.operation, "Knowledge operation");
        if (operation === "add") {
          if (Object.keys(body).some((key) => !["operation", "text", "taskCategory"].includes(key))) throw new Error("Invalid add request");
          if (!(["rename", "refactor", "analysis", "test", "other"] as unknown[]).includes(body.taskCategory)) throw new Error("Invalid task category");
          return json(response, 200, await store.note("project", required(body.text, "Lesson text"), body.taskCategory as "rename" | "refactor" | "analysis" | "test" | "other"));
        }
        if (operation === "review") {
          if (Object.keys(body).some((key) => !["operation", "id", "status"].includes(key)) || body.status !== "approved" && body.status !== "rejected") throw new Error("Invalid review request");
          return json(response, 200, await store.review(required(body.id, "Knowledge ID"), body.status));
        }
        if (operation === "edit") {
          if (Object.keys(body).some((key) => !["operation", "id", "text"].includes(key))) throw new Error("Invalid edit request");
          return json(response, 200, await store.edit(required(body.id, "Knowledge ID"), required(body.text, "Lesson text")));
        }
        if (operation === "promote") {
          if (Object.keys(body).some((key) => !["operation", "id"].includes(key))) throw new Error("Invalid promote request");
          return json(response, 200, await store.promote(required(body.id, "Knowledge ID")));
        }
        if (operation === "remove") {
          if (Object.keys(body).some((key) => !["operation", "id", "scope"].includes(key)) || body.scope !== "project" && body.scope !== "global") throw new Error("Invalid remove request");
          await store.remove(body.scope, required(body.id, "Knowledge ID"));
          return json(response, 200, { removed: body.id });
        }
        throw new Error("Unknown knowledge operation");
      } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (request.method !== "GET") return json(response, 405, { error: "Read-only API" });
    const url = new URL(request.url ?? "/", `http://${host}`);
    try {
      if (url.pathname === "/api/project") {
        try { return json(response, 200, { registered: true, project: (await new CommandService(project).detail()).project }); }
        catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" || error instanceof Error && error.message.startsWith("No orch project")) return json(response, 200, { registered: false, directory: project }); throw error; }
      }
      if (url.pathname === "/api/commands") return json(response, 200, await new CommandService(project).detail());
      if (url.pathname === "/api/checks") return json(response, 200, await checkReport(new CommandService(project), url.searchParams.get("taskId") ?? undefined));
      if (url.pathname === "/api/commands/shared") return json(response, 200, await new CommandService(project).sharedView());
      if (url.pathname === "/api/workflow") {
        const [detail, worktrees, signal] = await Promise.all([new CommandService(project).detail(), new WorktreeManager(project).load(), readCapacity(project)]);
        return json(response, 200, { revision: detail.revision, base: detail.worktreeBase ?? null, worktrees: await worktrees.detail(),
          capacity: { availability: capacityAvailability(signal), ...(signal ? { signal } : {}) },
          policy: { version: detail.policy.revision, routing: detail.policy.value.routing ?? { limits: {}, rules: {} }, history: detail.policy.value.history ?? [] },
          runs: detail.runs, jobs: [...jobs.values()] });
      }
      if (url.pathname === "/api/shared/runs") return json(response, 200, await localSharedSnapshot(project));
      if (url.pathname === "/api/tasks") return json(response, 200, { tasks: await tasks(project) });
      if (url.pathname === "/api/models") {
        const [registry, history] = await Promise.all([loadRegistry(project), new KnowledgeStore(project).list("project")]);
        const observations = registry.models.map((profile) => {
          const live = history.filter((entry) => entry.kind === "attempt" && !entry.simulated && entry.model === `${profile.provider}:${profile.model}` && entry.route === profile.tier);
          return { alias: profile.alias, liveAttempts: live.length, validatedPasses: live.filter((entry) => entry.kind === "attempt" && entry.passed).length };
        });
        return json(response, 200, { ...registry, observations });
      }
      if (url.pathname === "/api/history") {
        const entries = (await new KnowledgeStore(project).list("project")).filter((entry) => entry.kind === "attempt");
        return json(response, 200, { attempts: entries });
      }
      if (url.pathname === "/api/knowledge") {
        const knowledge = new KnowledgeStore(project);
        const [projectEntries, globalEntries, events, taskRecords] = await Promise.all([
          knowledge.list("project"), knowledge.list("global"), readRunEvents(project), tasks(project),
        ]);
        const lessons = [...projectEntries, ...globalEntries].filter((entry) => entry.kind === "note" && entry.reviewStatus === "approved");
        const notes = projectEntries.filter((entry) => entry.kind === "note" && entry.reviewStatus !== "approved");
        const candidates = projectEntries.filter((entry) => entry.kind === "candidate" && entry.reviewStatus === "pending");
        const retrieval = await Promise.all(taskRecords.map(async (record) => ({ taskId: record.spec.id,
          selections: (await knowledge.retrieve(record.spec)).map(({ entry, reason }) => ({ id: entry.id, scope: entry.scope, reason })),
        })));
        const modes = new Map(events.filter((event) => event.type === "run.started").map((event) => [event.runId, event.mode]));
        const usedInRuns = events.filter((event) => event.type === "knowledge.selected").map((event) => ({
          runId: event.runId, taskId: event.taskId, at: event.at, mode: modes.get(event.runId) ?? "live",
          lessonIds: event.lessonIds, selections: event.selections,
        }));
        return json(response, 200, { lessons, notes, candidates, retrieval, usedInRuns });
      }
      if (url.pathname === "/api/model-proposals") {
        const [taskRecords, registry, entries, prices, detail] = await Promise.all([
          tasks(project), loadRegistry(project), new KnowledgeStore(project).list("project"), priceSnapshot(project), new CommandService(project).detail(),
        ]);
        const attempts = entries.filter((entry) => entry.kind === "attempt");
        const routing = detail.policy.value.routing ?? { limits: {}, rules: {} };
        return json(response, 200, { priceVersion: prices?.version, proposals: taskRecords.map((record) => ({
          taskId: record.spec.id, proposal: constrainProposal(recommendModelRoute({ task: record.spec, registry, attempts, prices }), record.spec, routing, registry, attempts, prices),
        })) });
      }
      if (url.pathname === "/api/runs") return json(response, 200, { runs: summarizeRuns(await readRunEvents(project)) });
      const match = /^\/api\/runs\/([0-9a-f-]{36})\/events$/.exec(url.pathname);
      if (match) {
        const afterValue = url.searchParams.get("after") ?? "0";
        const after = Number(afterValue);
        if (!Number.isSafeInteger(after) || after < 0) return json(response, 400, { error: "after must be a nonnegative integer" });
        const runEvents = (await readRunEvents(project)).filter((event) => event.runId === match[1]);
        if (!runEvents.length) return json(response, 404, { error: "Unknown run" });
        return json(response, 200, { events: runEvents.filter((event) => event.sequence > after).slice(0, 1000) });
      }
      return json(response, 404, { error: "Unknown endpoint" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: message });
    }
  });
}
