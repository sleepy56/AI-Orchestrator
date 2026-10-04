const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const Module = require("node:module");
const { join } = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = join(__dirname, "..", "src", "replay.ts");
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics, []);
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = module.paths;
loaded._compile(compiled.outputText, sourcePath);
const { replayRun } = loaded.exports;

const task = (id, dependsOn = [], status = "pending") => ({
  spec: { id, description: id, dependsOn, type: "test", difficulty: "moderate", risk: "medium" },
  status, attempts: [],
});
const runId = "11111111-1111-1111-1111-111111111111";
const run = { runId, mode: "simulated", startedAt: "2026-01-01T00:00:00Z", lastSequence: 7, status: "finished" };
const attempt = { attempt: 1, validation: { passed: false, errors: ["check failed"] }, checkCommand: "npm test" };
const events = [
  { runId, sequence: 1, type: "run.started", at: run.startedAt, mode: "simulated", tasks: [task("A"), task("B", ["A"])] },
  { runId, sequence: 2, type: "task.started", at: run.startedAt, taskId: "A" },
  { runId, sequence: 3, type: "route.decided", at: run.startedAt, taskId: "A", chosenAlias: "sol-high" },
  { runId, sequence: 4, type: "attempt.started", at: run.startedAt, taskId: "A", attempt: 1 },
  { runId, sequence: 5, type: "attempt.finished", at: run.startedAt, taskId: "A", attempt, simulated: true },
  { runId, sequence: 6, type: "task.finished", at: run.startedAt, taskId: "A", status: "failed", failureReason: "check failed" },
  { runId, sequence: 7, type: "run.finished", at: run.startedAt, blocked: ["B"] },
];

test("replay shows only state and evidence available at the selected event", () => {
  const before = replayRun(run, events, 3);
  assert.deepEqual(before.tasks.map((item) => item.displayStatus), ["running", "blocked"]);
  assert.equal(before.tasks[0].attempts.length, 0);
  assert.equal(before.run.status, "running");

  const validated = replayRun(run, events, 5);
  assert.equal(validated.tasks[0].status, "running");
  assert.deepEqual(validated.tasks[0].attempts, [attempt]);

  const failed = replayRun(run, events, 7);
  assert.deepEqual(failed.tasks.map((item) => item.displayStatus), ["failed", "blocked"]);
  assert.equal(failed.tasks[0].failureReason, "check failed");
  assert.equal(failed.run.status, "finished");
  assert.equal(events[0].tasks[0].status, "pending");
});

test("completion unblocks dependent tasks at the correct event", () => {
  const completed = events.map((event) => event.sequence === 6 ? { ...event, status: "completed" } : event);
  assert.equal(replayRun(run, completed, 5).tasks[1].displayStatus, "blocked");
  assert.equal(replayRun(run, completed, 6).tasks[1].displayStatus, "ready");
});
