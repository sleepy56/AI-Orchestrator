import assert from "node:assert/strict";
import test from "node:test";
import { FakeExecutor } from "./executor";
import { orchestrate } from "./orchestrator";
import { routeTask } from "./router";
import { ProviderConfigurationError } from "./providers";
import { TaskGraph } from "./scheduler";
import { TaskSpec } from "./types";

function task(id: string, dependsOn: string[] = []): TaskSpec {
  return {
    id,
    description: id === "TASK-001" ? "Rename UserGoal to Goal" : `Run ${id}`,
    type: "rename",
    difficulty: "easy",
    risk: "low",
    dependsOn,
  };
}

test("single rename routes to Luna and completes after validation", async () => {
  const graph = TaskGraph.fromSpecs([task("TASK-001")]);
  const executor = new FakeExecutor();
  assert.equal(routeTask(graph.get("TASK-001").spec).label, "luna-low");

  const result = await orchestrate(graph, executor);
  assert.deepEqual(result.batches, [["TASK-001"]]);
  assert.equal(graph.status("TASK-001"), "completed");
  assert.equal(graph.get("TASK-001").attempts[0].validation.passed, true);
  assert.deepEqual(executor.calls.map((call) => call.route), ["luna-low"]);
});

test("graph releases siblings together, then waits for both before T4", async () => {
  const graph = TaskGraph.fromSpecs([
    task("T1"),
    task("T2", ["T1"]),
    task("T3", ["T1"]),
    task("T4", ["T2", "T3"]),
  ]);
  assert.equal(graph.status("T4"), "blocked");

  const result = await orchestrate(graph, new FakeExecutor());
  assert.deepEqual(result.batches, [["T1"], ["T2", "T3"], ["T4"]]);
  assert.deepEqual(result.snapshot.tasks.map((record) => record.status), [
    "completed", "completed", "completed", "completed",
  ]);
});

test("Luna failure retries Luna, then escalates to Sol", async () => {
  const graph = TaskGraph.fromSpecs([task("T1")]);
  const executor = new FakeExecutor({ T1: ["fail", "invalid", "pass"] });
  await orchestrate(graph, executor);

  assert.deepEqual(executor.calls.map((call) => call.route), [
    "luna-low", "luna-low", "sol-medium",
  ]);
  assert.deepEqual(graph.get("T1").attempts.map((attempt) => attempt.validation.passed), [
    false, false, true,
  ]);
  assert.equal(graph.status("T1"), "completed");
});

test("exhausted attempts fail the task and leave dependents blocked", async () => {
  const graph = TaskGraph.fromSpecs([task("T1"), task("T2", ["T1"])]);
  const executor = new FakeExecutor({ T1: ["fail", "fail", "fail", "fail"] });
  const result = await orchestrate(graph, executor);

  assert.equal(graph.status("T1"), "failed");
  assert.equal(graph.status("T2"), "blocked");
  assert.deepEqual(result.blocked, ["T2"]);
  assert.equal(executor.calls.length, 4);
});

test("router raises effort for risk, difficulty, and work type", () => {
  assert.equal(routeTask(task("T1")).label, "luna-low");
  assert.equal(routeTask({ ...task("T2"), type: "refactor" }).label, "sol-medium");
  assert.equal(routeTask({ ...task("T3"), risk: "high" }).label, "sol-high");
});

test("scheduler rejects missing dependencies and cycles", () => {
  assert.throws(() => TaskGraph.fromSpecs([task("T1", ["unknown"])]), /unknown dependency/);
  assert.throws(() => TaskGraph.fromSpecs([task("T1", ["T2"]), task("T2", ["T1"])]), /cycle/);
});

test("live-style executor serializes ready siblings and publishes running states", async () => {
  const graph = TaskGraph.fromSpecs([task("T1"), task("T2")]);
  let active = 0;
  let maximum = 0;
  const states: string[][] = [];
  await orchestrate(graph, {
    parallel: false,
    async execute(spec, route, attempt) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { taskId: spec.id, route, attempt, succeeded: true, output: "Validated completion" };
    },
  }, (snapshot) => { states.push(snapshot.tasks.map((record) => record.status)); });
  assert.equal(maximum, 1);
  assert.deepEqual(states, [["running", "pending"], ["completed", "pending"], ["completed", "running"], ["completed", "completed"]]);
});

test("provider configuration errors fail once instead of repeatedly calling a broken provider", async () => {
  const graph = TaskGraph.fromSpecs([task("T1")]);
  let calls = 0;
  await orchestrate(graph, {
    async execute() { calls += 1; throw new ProviderConfigurationError("model unavailable"); },
  });
  assert.equal(calls, 1);
  assert.equal(graph.get("T1").attempts.length, 1);
  assert.equal(graph.status("T1"), "failed");
});

test("a persisted running task is never silently replayed", () => {
  const graph = new TaskGraph({ tasks: [{ spec: task("T1"), status: "running", attempts: [] }] });
  assert.equal(graph.status("T1"), "running");
  assert.deepEqual(graph.ready(), []);
  graph.retry("T1");
  assert.equal(graph.status("T1"), "ready");
});
