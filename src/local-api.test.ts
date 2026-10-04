import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalApi } from "./local-api";
import { readRunEvents } from "./run-events";

test("run events persist in order and local API exposes read-only project state", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-api-"));
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, "cli.js"), ...args], { cwd: project, encoding: "utf8" });
  const server = createLocalApi(project);
  try {
    assert.equal(cli("init").status, 0);
    assert.equal(cli("plan", "First task").status, 0);
    assert.equal(cli("plan", "Second task", "--after", "TASK-001").status, 0);
    const run = cli("run", "--once");
    assert.equal(run.status, 0, run.stderr);
    const events = await readRunEvents(project);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.equal(new Set(events.map((event) => event.runId)).size, 1);
    assert.deepEqual(events.map((event) => event.type), [
      "run.started", "task.started", "route.decided", "attempt.started", "attempt.finished", "task.finished", "run.finished",
    ]);
    assert.equal(events[0].type === "run.started" && events[0].mode, "simulated");
    assert.equal(events[2].type === "route.decided" && events[2].reason, "medium risk, moderate difficulty, refactor, or analysis");
    assert.equal(events[4].type === "attempt.finished" && events[4].simulated, true);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const get = async (path: string) => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const taskState = await get("/api/tasks");
    assert.deepEqual(taskState.body.tasks.map((task: { displayStatus: string }) => task.displayStatus), ["completed", "ready"]);
    const models = await get("/api/models");
    assert.equal(models.body.models[0].alias, "luna-low");
    assert.equal(models.body.observations[0].liveAttempts, 0);
    const history = await get("/api/history");
    assert.equal(history.body.attempts[0].simulated, true);
    const runs = await get("/api/runs");
    assert.equal(runs.body.runs[0].status, "finished");
    const timeline = await get(`/api/runs/${events[0].runId}/events?after=2`);
    assert.deepEqual(timeline.body.events.map((event: { sequence: number }) => event.sequence), [3, 4, 5, 6, 7]);
    assert.equal((await get(`/api/runs/${events[0].runId}/events?after=-1`)).status, 400);
    const before = await readFile(join(project, ".orch", "tasks.json"), "utf8");
    const response = await fetch(`${base}/api/tasks`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(await readFile(join(project, ".orch", "tasks.json"), "utf8"), before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(project, { recursive: true, force: true });
  }
});
