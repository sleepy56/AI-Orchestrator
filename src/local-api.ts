import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
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
        const candidates = projectEntries.filter((entry) => entry.kind === "candidate" && entry.reviewStatus === "pending");
        const retrieval = await Promise.all(taskRecords.map(async (record) => ({ taskId: record.spec.id,
          selections: (await knowledge.retrieve(record.spec)).map(({ entry, reason }) => ({ id: entry.id, scope: entry.scope, reason })),
        })));
        const modes = new Map(events.filter((event) => event.type === "run.started").map((event) => [event.runId, event.mode]));
        const usedInRuns = events.filter((event) => event.type === "knowledge.selected").map((event) => ({
          runId: event.runId, taskId: event.taskId, at: event.at, mode: modes.get(event.runId) ?? "live",
          lessonIds: event.lessonIds, selections: event.selections,
        }));
        return json(response, 200, { lessons, candidates, retrieval, usedInRuns });
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
