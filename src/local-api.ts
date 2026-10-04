import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KnowledgeStore } from "./knowledge";
import { loadRegistry } from "./models";
import { readRunEvents, summarizeRuns } from "./run-events";
import { TaskGraph } from "./scheduler";
import { TaskSnapshot } from "./types";

async function tasks(project: string) {
  const snapshot = JSON.parse(await readFile(join(project, ".orch", "tasks.json"), "utf8")) as TaskSnapshot;
  const graph = new TaskGraph(snapshot);
  return graph.snapshot().tasks.map((record) => ({ ...record, displayStatus: graph.status(record.spec.id) }));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function createLocalApi(project: string): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host ?? "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return json(response, 403, { error: "Local host required" });
    if (request.method !== "GET") return json(response, 405, { error: "Read-only API" });
    const url = new URL(request.url ?? "/", `http://${host}`);
    try {
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
