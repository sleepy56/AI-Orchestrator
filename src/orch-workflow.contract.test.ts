import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { KnowledgeStore, AttemptEntry } from "./knowledge";
import { createLocalApi } from "./local-api";
import { loadRegistry, selectModel } from "./models";
import { routeTask } from "./router";
import { TaskSpec } from "./types";
import { actionGate, CommandService, executionGate } from "./command-service";
import { PlanningWorkflow } from "./planning";
import { checkReport } from "./checks";
import { FakeExecutor } from "./executor";
import { orchestrate } from "./orchestrator";
import { TaskGraph } from "./scheduler";
import { WorktreeManager } from "./worktrees";
import { CapacityScheduler, readCapacity } from "./capacity";
import { readRunEvents } from "./run-events";
import { localSharedSnapshot, validateSharedSnapshot } from "./shared-metadata";
import { PostgresMetadata } from "./postgres-metadata";

test("[TASK-022] a provider capacity failure defers its task instead of failing it", async () => {
  const task: TaskSpec = { id: "TASK-001", description: "Rename a symbol", type: "rename", difficulty: "easy", risk: "low", dependsOn: [] };
  const graph = TaskGraph.fromSpecs([task]);
  const paused = await orchestrate(graph, { parallel: false, execute: async (_task, route, attempt) => ({
    taskId: task.id, route, attempt, succeeded: false, output: "", retryable: false,
    error: "Quota reached", capacityReason: "Provider capacity failure: quota reached",
  }) });
  assert.match(paused.paused ?? "", /quota reached/);
  assert.equal(graph.get(task.id).status, "pending");
  assert.equal(graph.get(task.id).attempts.length, 1);
  const fake = new FakeExecutor();
  await orchestrate(graph, fake);
  assert.equal(graph.get(task.id).status, "completed");
  assert.equal(fake.calls[0].attempt, 2);
});

test("[TASK-022] measured near-limit capacity checkpoints starts, resumes after a fresh signal, and keeps unknown quota unknown", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "Small rename", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
  assert.equal(cli(project, home, "plan", "Another rename", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
  const signalPath = join(project, ".orch", "capacity.json");
  const snapshotPath = join(project, ".orch", "tasks.json");
  const graph = new TaskGraph(JSON.parse(await readFile(snapshotPath, "utf8")));
  const registry = await loadRegistry(project);
  const scheduler = await CapacityScheduler.load(project, registry);
  const executor = new FakeExecutor();
  await writeFile(signalPath, JSON.stringify({ provider: "codex", observedAt: new Date().toISOString(), remainingTokens: 1_000, limitTokens: 100_000, maxConcurrent: 3 }));
  const paused = await orchestrate(graph, executor, (snapshot) => writeFile(snapshotPath, JSON.stringify(snapshot)),
    { capacity: (task, inFlight) => scheduler.decide(task, inFlight) });
  assert.match(paused.paused ?? "", /near exhaustion/);
  assert.equal(executor.calls.length, 0);
  assert.ok(paused.snapshot.tasks.every((record) => record.status === "pending"));
  assert.equal((await readCapacity(project))?.remainingTokens, 1_000);

  await writeFile(signalPath, JSON.stringify({ provider: "codex", observedAt: new Date().toISOString(), remainingTokens: 1_000_000, limitTokens: 1_000_000, maxConcurrent: 3 }));
  const resumed = await orchestrate(new TaskGraph(JSON.parse(await readFile(snapshotPath, "utf8"))), executor, undefined,
    { capacity: (task, inFlight) => scheduler.decide(task, inFlight) });
  assert.equal(resumed.paused, undefined);
  assert.equal(executor.calls.length, 2);
  assert.ok(resumed.snapshot.tasks.every((record) => record.status === "completed"));
  await rm(signalPath);
  assert.equal((await scheduler.decide(resumed.snapshot.tasks[0].spec, [])).availability, "unknown");
  assert.match(cli(project, home, "capacity").stdout, /"availability": "unknown"/);
}));

test("[TASK-022] concurrency is bounded by measured workers and uncertain projected USD cost", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "First rename", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
  const task = new TaskGraph(JSON.parse(await readFile(join(project, ".orch", "tasks.json"), "utf8"))).ready()[0];
  const capacityPath = join(project, ".orch", "capacity.json");
  const settingsPath = join(project, ".orch", "scheduler.json");
  await writeFile(capacityPath, JSON.stringify({ provider: "codex", observedAt: new Date().toISOString(), remainingTokens: 900_000, limitTokens: 1_000_000, maxConcurrent: 2 }));
  await writeFile(settingsPath, JSON.stringify({ maxWorkers: 4, maxProjectedCostUsd: 0.1 }));
  const registry = await loadRegistry(project);
  const noPrice = await CapacityScheduler.load(project, registry);
  assert.match((await noPrice.decide(task, [])).reason ?? "", /Projected cost is unknown/);
  await writeFile(join(project, ".orch", "prices.json"), JSON.stringify({ version: "test", currency: "USD", models: {
    "codex:gpt-6-luna": { inputPerMillion: 10, outputPerMillion: 10 },
  } }));
  const priced = await CapacityScheduler.load(project, registry);
  assert.match((await priced.decide(task, [])).reason ?? "", /cost exceeds/);
  await writeFile(settingsPath, JSON.stringify({ maxWorkers: 4, maxProjectedCostUsd: 1 }));
  const roomy = await CapacityScheduler.load(project, registry);
  const decision = await roomy.decide(task, []);
  assert.equal(decision.availability, "known");
  assert.equal(decision.limit, Math.min(2, availableParallelism()));
  assert.equal((await roomy.decide(task, [task])).limit, 1);
  await writeFile(capacityPath, JSON.stringify({ provider: "codex", observedAt: new Date(Date.now() - 600_000).toISOString(), remainingTokens: 900_000, maxConcurrent: 2 }));
  assert.match((await roomy.decide(task, [])).reason ?? "", /stale/);
  assert.match(cli(project, home, "capacity").stdout, /"availability": "unknown"/);
}));

test("[TASK-022] a paused run safely recovers an interrupted task before starting again", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "Recover work").status, 0);
  const service = new CommandService(project);
  const runId = "123e4567-e89b-42d3-a456-426614174022";
  await service.execute({ version: 1, kind: "run.record", expectedRevision: await service.revision(),
    payload: { runId, status: "running", mode: "simulated" } });
  const path = join(project, ".orch", "tasks.json");
  const graph = new TaskGraph(JSON.parse(await readFile(path, "utf8")));
  graph.markRunning("TASK-001");
  await writeFile(path, JSON.stringify(graph.snapshot()));
  const result = cli(project, home, "run", "--resume", runId);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TASK-001: completed/);
  assert.equal((await service.detail()).runs[runId].value.status, "finished");
  const events = (await readRunEvents(project)).filter((event) => event.runId === runId);
  assert.ok(events.some((event) => event.type === "run.paused" && event.reason === "Previous run was interrupted"));
  assert.ok(events.some((event) => event.type === "task.interrupted"));
}));

test("[TASK-022] a live capacity pause persists and resumes the same run after remeasurement", async () => fixture(async (project, other, home) => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  await writeFile(join(project, "README.md"), "Capacity fixture\n");
  git("add", ".");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "Complete a small rename", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
  assert.equal(cli(project, home, "worktrees", "base", "main", base).status, 0);
  const bin = join(other, "bin");
  const entry = join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));\n");
  await writeFile(join(bin, "codex.cmd"), "rem fake launcher\n");
  const launcher = join(bin, "codex");
  await writeFile(launcher, `#!/bin/sh\n"${process.execPath}" "${entry}" "$@"\n`);
  await chmod(launcher, 0o755);
  const path = process.platform === "win32" ? [bin, dirname(process.execPath), "C:\\Program Files\\Git\\cmd", "C:\\Windows\\system32"].join(delimiter)
    : [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  const run = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, "cli.js"), ...args], {
    cwd: project, encoding: "utf8", env: { ...process.env, ORCH_HOME: home, PATH: path },
  });
  const signalPath = join(project, ".orch", "capacity.json");
  await writeFile(signalPath, JSON.stringify({ provider: "codex", observedAt: new Date().toISOString(), remainingTokens: 1_000, limitTokens: 1_000_000, maxConcurrent: 2 }));
  const paused = run("run", "--executor", "codex", "--check", "node -e \"process.exit(0)\"");
  assert.equal(paused.status, 0, paused.stderr);
  const runId = /Run ID: ([a-f0-9-]+)/.exec(paused.stdout)?.[1];
  assert.ok(runId, paused.stdout);
  assert.match(paused.stdout, /paused: Provider capacity near exhaustion/);
  assert.equal(Object.keys((await (await new WorktreeManager(project).load()).detail()).workers).length, 0);
  assert.equal((await new CommandService(project).detail()).runs[runId].value.status, "paused");
  const snapshotPath = join(project, ".orch", "tasks.json");
  const interrupted = new TaskGraph(JSON.parse(await readFile(snapshotPath, "utf8")));
  const task = interrupted.ready()[0];
  interrupted.markRunning(task.id);
  await writeFile(snapshotPath, JSON.stringify(interrupted.snapshot()));
  const worker = await (await new WorktreeManager(project).load()).prepare(task);
  await writeFile(join(worker.path, "partial.txt"), "unfinished work\n");
  const unsafe = run("run", "--resume", runId, "--check", "node -e \"process.exit(0)\"");
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /inspect changes, then use orch retry/);
  assert.equal((await readFile(join(worker.path, "partial.txt"), "utf8")).trim(), "unfinished work");
  assert.equal(cli(project, home, "retry", task.id).status, 0);
  assert.equal(cli(project, home, "worktrees", "base", "main", base).status, 0);
  await writeFile(signalPath, JSON.stringify({ provider: "codex", observedAt: new Date().toISOString(), remainingTokens: 1_000_000, limitTokens: 1_000_000, maxConcurrent: 2 }));
  const resumed = run("run", "--resume", runId, "--check", "node -e \"process.exit(0)\"");
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.equal((await new CommandService(project).detail()).runs[runId].value.status, "finished");
  assert.ok((await readRunEvents(project)).some((event) => event.runId === runId && event.type === "run.resumed"));
}));

test("[TASK-021] live CLI workers validate inside separate worktrees and record Codex context IDs", async () => fixture(async (project, other, home) => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  await writeFile(join(project, ".gitignore"), ".orch/\n");
  await writeFile(join(project, "README.md"), "Worker context\n");
  git("add", ".");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  assert.equal(cli(project, home, "init", "--docs", "README.md").status, 0);
  assert.equal(cli(project, home, "plan", "Write first").status, 0);
  assert.equal(cli(project, home, "plan", "Write second").status, 0);
  const service = new CommandService(project);
  await service.execute({ version: 1, kind: "check.put", expectedRevision: await service.revision(), payload: {
    taskId: "TASK-001", command: "node -e \"process.exit(require('fs').existsSync('TASK-001.txt')?0:1)\"",
    phase: "task", cwd: ".", timeoutSeconds: 20, expected: "exit 0" } });
  await service.execute({ version: 1, kind: "check.put", expectedRevision: await service.revision(), payload: {
    taskId: "TASK-002", command: "node -e \"process.exit(require('fs').existsSync('TASK-002.txt')?0:1)\"",
    phase: "task", cwd: ".", timeoutSeconds: 20, expected: "exit 0" } });
  const bin = join(other, "bin");
  const entry = join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
  const capture = join(other, "capture.jsonl");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, [
    "const fs = require('node:fs');",
    "const id = /Complete task (TASK-\\d+)/.exec(process.argv.at(-1))[1];",
    "const other = id === 'TASK-001' ? 'TASK-002.txt' : 'TASK-001.txt';",
    "if (fs.existsSync(other)) process.exit(2);",
    "fs.writeFileSync(id + '.txt', id);",
    "fs.appendFileSync(process.env.ORCH_CAPTURE, JSON.stringify({id, cwd:process.cwd(), prompt:process.argv.at(-1)}) + '\\n');",
    "console.log(JSON.stringify({type:'thread.started',thread_id:'thread-' + id}));",
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));",
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));",
  ].join("\n"));
  await writeFile(join(bin, "codex.cmd"), "rem fake Codex launcher\n");
  const unixLauncher = join(bin, "codex");
  await writeFile(unixLauncher, `#!/bin/sh\n"${process.execPath}" "${entry}" "$@"\n`);
  await chmod(unixLauncher, 0o755);
  const path = process.platform === "win32"
    ? [bin, dirname(process.execPath), "C:\\Program Files\\Git\\cmd", "C:\\Windows\\system32"].join(delimiter)
    : [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  const run = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, "cli.js"), ...args], {
    cwd: project, encoding: "utf8", timeout: 30_000, env: { ...process.env, ORCH_HOME: home, ORCH_CAPTURE: capture, PATH: path },
  });
  const check = "node -e \"process.exit(require('fs').readdirSync('.').some(x=>x.endsWith('.txt'))?0:1)\"";
  assert.match(run("run", "--executor", "codex", "--check", check).stderr, /approved worktree base/i);
  assert.equal(cli(project, home, "worktrees", "base", "main", base).status, 0);
  const result = run("run", "--executor", "codex", "--check", check);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manager = await new WorktreeManager(project).load();
  const workers = (await manager.detail()).workers;
  assert.equal(workers["TASK-001"].contextId, "thread-TASK-001");
  assert.equal(workers["TASK-002"].contextId, "thread-TASK-002");
  assert.equal(workers["TASK-001"].validation?.passed, true);
  assert.equal(workers["TASK-002"].validation?.passed, true);
  const captures = (await readFile(capture, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { id: string; cwd: string; prompt: string });
  assert.equal(captures.length, 2);
  assert.ok(captures.every((item) => item.cwd === workers[item.id].path && item.prompt.includes("pinned base")));
  assert.ok(Object.values((await service.detail()).checks).every((check) => check.results.at(-1)?.status === "pass"));
  assert.equal(git("rev-parse", "main"), base);
}));

test("[TASK-021] sibling worktrees stay isolated, retain context and lessons, and expose integration conflicts", async () => fixture(async (project, _other, home) => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  await writeFile(join(project, ".gitignore"), ".orch/\n");
  await writeFile(join(project, "README.md"), "Fixture context\n");
  await writeFile(join(project, "shared.txt"), "base\n");
  git("add", ".");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  assert.equal(cli(project, home, "init", "--docs", "README.md").status, 0);
  assert.equal(cli(project, home, "plan", "Change shared left").status, 0);
  assert.equal(cli(project, home, "plan", "Change shared right").status, 0);
  assert.equal(cli(project, home, "plan", "Build on both", "--after", "TASK-001,TASK-002").status, 0);
  assert.equal(cli(project, home, "worktrees", "base", "main", base).status, 0);
  const tasks = (await new CommandService(project).detail()).tasks.map((entry) => entry.spec);
  const manager = await new WorktreeManager(project).load();
  const [left, right] = await Promise.all([manager.prepare(tasks[0], ["lesson-left"]), manager.prepare(tasks[1], ["lesson-right"])]);
  assert.notEqual(left.path, right.path);
  assert.equal(left.base, base);
  assert.equal(right.base, base);
  assert.deepEqual(left.contextDocuments, ["README.md"]);
  await writeFile(join(left.path, "shared.txt"), "left\n");
  assert.equal((await readFile(join(right.path, "shared.txt"), "utf8")).trim(), "base");
  await writeFile(join(right.path, "shared.txt"), "right\n");
  await manager.finish(tasks[0].id, "thread-left", "node check.js", true, "pass");
  await manager.finish(tasks[1].id, "thread-right", "node check.js", true, "pass");
  const detail = await manager.detail();
  assert.deepEqual(detail.workers[tasks[0].id].lessonIds, ["lesson-left"]);
  assert.equal(detail.workers[tasks[0].id].contextId, "thread-left");
  assert.equal(detail.workers[tasks[1].id].contextId, "thread-right");
  const integrated = await manager.integrate(tasks.slice(0, 2).map((task) => task.id), "node -e \"process.exit(0)\"");
  assert.deepEqual(integrated.conflicts, ["shared.txt"]);
  assert.match(integrated.diff, /left|right/);
  assert.equal(integrated.actionId, undefined);
  assert.equal(git("rev-parse", "main"), base);
  await assert.rejects(manager.verifyIntegration(integrated.id, "node -e \"process.exit(0)\""), /Resolve all integration conflicts/);
  await writeFile(join(integrated.path, "shared.txt"), "left and right\n");
  git("-C", integrated.path, "add", "shared.txt");
  git("-C", integrated.path, "-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Resolve integration");
  const verified = await manager.verifyIntegration(integrated.id,
    "node -e \"process.exit(require('fs').readFileSync('shared.txt','utf8').includes('left and right')?0:1)\"");
  assert.deepEqual(verified.conflicts, []);
  assert.equal(verified.check?.passed, true, verified.check?.output);
  assert.ok(verified.actionId);
  const dependent = await manager.prepare(tasks[2]);
  assert.deepEqual(dependent.integrationIds, [integrated.id]);
  assert.deepEqual(dependent.dependencies, { "TASK-001": detail.workers[tasks[0].id].commit, "TASK-002": detail.workers[tasks[1].id].commit });
  assert.equal((await readFile(join(dependent.path, "shared.txt"), "utf8")).trim(), "left and right");
  assert.equal(git("-C", dependent.path, "merge-base", "--is-ancestor", verified.commit!, dependent.base), "");
  assert.equal(git("rev-parse", "main"), base);
}));

test("[TASK-021] dependency bases and combined checks produce an exact merge request before target changes", async () => fixture(async (project, _other, home) => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  await writeFile(join(project, ".gitignore"), ".orch/\n");
  await writeFile(join(project, "README.md"), "Fixture context\n");
  git("add", ".");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  assert.equal(cli(project, home, "init", "--docs", "README.md").status, 0);
  assert.equal(cli(project, home, "plan", "Write left").status, 0);
  assert.equal(cli(project, home, "plan", "Write right").status, 0);
  assert.equal(cli(project, home, "plan", "Build on left", "--after", "TASK-001").status, 0);
  assert.equal(cli(project, home, "worktrees", "base", "main", base).status, 0);
  const tasks = (await new CommandService(project).detail()).tasks.map((entry) => entry.spec);
  const manager = await new WorktreeManager(project).load();
  const left = await manager.prepare(tasks[0]);
  const right = await manager.prepare(tasks[1]);
  await writeFile(join(left.path, "left.txt"), "left\n");
  await writeFile(join(right.path, "right.txt"), "right\n");
  const leftDone = await manager.finish(tasks[0].id, "thread-left", "check", true, "pass");
  await manager.finish(tasks[1].id, "thread-right", "check", true, "pass");
  const dependent = await manager.prepare(tasks[2]);
  assert.equal(git("merge-base", "--is-ancestor", leftDone.commit!, dependent.base), "");
  assert.deepEqual(dependent.dependencies, { "TASK-001": leftDone.commit });
  assert.equal((await readFile(join(dependent.path, "left.txt"), "utf8")).trim(), "left");
  await writeFile(join(dependent.path, "dependent.txt"), "dependent\n");
  await manager.finish(tasks[2].id, "thread-dependent", "check", true, "pass");
  const command = "node -e \"const fs=require('fs');process.exit(['left.txt','right.txt','dependent.txt'].every(x=>fs.existsSync(x))?0:1)\"";
  const integrated = await manager.integrate([tasks[2].id, tasks[1].id], command);
  assert.deepEqual(integrated.conflicts, []);
  assert.equal(integrated.check?.passed, true, integrated.check?.output);
  assert.match(integrated.diff, /dependent\.txt/);
  assert.ok(integrated.actionId);
  assert.equal(git("rev-parse", "main"), base);
  assert.notEqual(cli(project, home, "worktrees", "merge", integrated.actionId!).status, 0);
  assert.equal(cli(project, home, "actions", "approve", integrated.actionId!).status, 0);
  assert.equal(cli(project, home, "worktrees", "merge", integrated.actionId!).status, 0);
  assert.equal(git("rev-parse", "main"), integrated.commit);
  assert.equal((await readFile(join(project, "dependent.txt"), "utf8")).trim(), "dependent");
}));

test("[TASK-020] a new task start stops when an approval gate appears during a run", async () => {
  const graph = TaskGraph.fromSpecs(["TASK-001", "TASK-002"].map((id) => ({ id, description: id, type: "analysis", difficulty: "easy", risk: "low", dependsOn: [] })));
  const fake = new FakeExecutor();
  let starts = 0;
  const result = await orchestrate(graph, { parallel: false, execute: fake.execute.bind(fake) }, undefined, {
    beforeTask: () => ++starts === 1 ? undefined : "Checks revision 2 awaits approval",
  });
  assert.equal(result.paused, "Checks revision 2 awaits approval");
  assert.deepEqual(fake.calls.map((call) => call.taskId), ["TASK-001"]);
  assert.equal(graph.get("TASK-002").status, "pending");
});

test("[TASK-020] run pauses durably for exact plan and check approvals and resumes after CLI approval", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  const service = new CommandService(project);
  const task = { id: "TASK-101", description: "Review result", type: "analysis", difficulty: "moderate", risk: "medium", dependsOn: [],
    acceptanceCriteria: ["Result is clear"], areas: ["docs"], workerProfile: "sol-medium", context: ["README.md"], verification: ["review: Inspect result"] };
  await service.execute({ version: 1, kind: "plan.goal", expectedRevision: await service.revision(), payload: { goal: "Review result", questions: [], tasks: [task] } });
  let state = await service.detail();
  assert.match(executionGate(state) ?? "", /Plan revision/);
  const paused = cli(project, home, "run", "--once");
  assert.equal(paused.status, 0, paused.stderr);
  const runId = /Run ([0-9a-f-]{36}) paused/.exec(paused.stdout)?.[1];
  assert.ok(runId);
  assert.equal((await service.detail()).runs[runId].value.status, "paused");
  assert.equal(cli(project, home, "draft", "approve").status, 0);
  state = await service.detail();
  assert.match(executionGate(state) ?? "", /Checks revision/);
  assert.match(cli(project, home, "run", "--resume", runId).stdout, /remains paused: Checks revision/);
  assert.equal(cli(project, home, "checks", "approve").status, 0);
  assert.equal(executionGate(await service.detail()), undefined);
  const resumed = cli(project, home, "run", "--resume", runId, "--once");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, new RegExp(`Run ID: ${runId}`));
  assert.equal((await service.detail()).runs[runId].value.status, "finished");

  state = await service.detail();
  await service.execute({ version: 1, kind: "check.put", expectedRevision: state.revision, payload: {
    taskId: "TASK-101", phase: "review", procedure: "Inspect changed output", timeoutSeconds: 60, expected: "Reviewer accepts" } });
  state = await service.detail();
  assert.match(executionGate(state) ?? "", /Checks revision/);
  await assert.rejects(service.execute({ version: 1, kind: "run.record", expectedRevision: state.revision,
    payload: { runId: "123e4567-e89b-42d3-a456-426614174000", status: "running", mode: "simulated" } }), /Checks revision/);
  assert.notEqual(cli(project, home, "command", "--json", JSON.stringify({ version: 1, kind: "approval.grant", expectedRevision: state.revision,
    payload: { target: "checks", targetRevision: state.checksRevision - 1, actor: "user" } })).status, 0);
  assert.equal(cli(project, home, "checks", "approve").status, 0);
  state = await service.detail();
  await service.execute({ version: 1, kind: "plan.draft", expectedRevision: state.revision, payload: { tasks: [task] } });
  assert.match(executionGate(await service.detail()) ?? "", /Plan revision/);
  state = await service.detail();
  const server = createLocalApi(project);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "approval.grant", expectedRevision: state.revision,
        payload: { target: "plan", targetRevision: state.plan.revision, actor: "user" } }) });
    assert.equal(response.status, 200);
    assert.match(executionGate(await service.detail()) ?? "", /Checks revision/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}));

test("[TASK-020] merge and deployment approvals are bound to action revision and destination", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  const service = new CommandService(project);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Base");
  const base = git("rev-parse", "HEAD"), integrated = "b".repeat(40), next = "c".repeat(40);
  git("branch", "release");
  const request = cli(project, home, "actions", "request", "merge", "main", integrated, "--base-revision", base);
  assert.equal(request.status, 0, request.stderr);
  const id = /Action ([0-9a-f-]{36})/.exec(request.stdout)?.[1];
  assert.ok(id);
  assert.match(actionGate(await service.detail(), id) ?? "", /awaits approval/);
  await assert.rejects(service.requireActionApproval(id), /awaits approval/);
  assert.equal(cli(project, home, "actions", "approve", id).status, 0);
  assert.deepEqual(await service.requireActionApproval(id), { target: "merge", destination: "main", artifactRevision: integrated,
    baseRevision: base, planRevision: 0, checksRevision: 0 });
  const revised = cli(project, home, "actions", "request", "merge", "release", next, "--base-revision", base, "--id", id);
  assert.equal(revised.status, 0, revised.stderr);
  assert.match(actionGate(await service.detail(), id) ?? "", /revision 2 awaits approval/);
  await assert.rejects(service.requireActionApproval(id), /awaits approval/);
  const deployment = cli(project, home, "actions", "request", "deployment", "staging", integrated);
  assert.equal(deployment.status, 0, deployment.stderr);
  const deploymentId = /Action ([0-9a-f-]{36})/.exec(deployment.stdout)?.[1];
  assert.ok(deploymentId);
  assert.match(actionGate(await service.detail(), deploymentId) ?? "", /deployment request/);
  assert.equal(cli(project, home, "actions", "approve", id).status, 0);
  await assert.rejects(service.requireActionApproval(deploymentId), /awaits approval/);
  assert.equal(cli(project, home, "actions", "approve", deploymentId).status, 0);
  assert.equal((await service.requireActionApproval(deploymentId)).destination, "staging");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Advance target");
  git("branch", "-f", "release", "HEAD");
  await assert.rejects(service.requireActionApproval(id), /Target branch release changed/);
  await service.execute({ version: 1, kind: "plan.add", expectedRevision: await service.revision(), payload: { description: "Another revision" } });
  await assert.rejects(service.requireActionApproval(deploymentId), /Plan or checks changed/);
}));

test("[TASK-020] a draft with missing check suggestions still has an approvable check set revision", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  const service = new CommandService(project);
  await service.execute({ version: 1, kind: "plan.goal", expectedRevision: await service.revision(), payload: { goal: "Inspect result", questions: [], tasks: [{
    id: "TASK-101", description: "Inspect result", type: "analysis", difficulty: "easy", risk: "low", dependsOn: [],
    acceptanceCriteria: ["Result is useful"], areas: ["docs"], workerProfile: "sol-medium", context: ["README.md"], verification: ["Inspect result"] }] } });
  const state = await service.detail();
  assert.equal(state.checksRevision, 1);
  assert.equal(cli(project, home, "draft", "approve").status, 0);
  assert.equal(cli(project, home, "checks", "approve").status, 0);
  assert.equal(executionGate(await service.detail()), undefined);
  assert.ok((await checkReport(service)).counts.missing >= 1);
}));

test("[TASK-019] baseline failure stays separate from task evidence, CLI checks execute, and revisions distinguish outcomes", async () => fixture(async (project, _other, home) => {
  await writeFile(join(project, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"", build: "node -e \"process.exit(0)\"" } }));
  await writeFile(join(project, "export.js"), "module.exports = { headers: ['name', 'age'] };\n");
  await writeFile(join(project, "export.test.js"), "const test = require('node:test'); const assert = require('node:assert/strict'); test('Export includes headers', () => assert.deepEqual(require('./export').headers, ['name', 'age']));\n");
  assert.equal(cli(project, home, "init").status, 0);
  const baseline = cli(project, home, "checks", "baseline");
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.match(baseline.stdout, /fail\s+baseline/);
  assert.equal((baseline.stdout.match(/baseline\s+project/g) ?? []).length, 2);
  assert.equal(cli(project, home, "plan", "Verify export", "--type", "test").status, 0);
  const service = new CommandService(project);
  let report = await checkReport(service, "TASK-001");
  assert.equal(report.counts.missing, 1);
  const command = "node --test export.test.js";
  const added = cli(project, home, "checks", "add", "TASK-001", "--command", command, "--phase", "task", "--timeout-seconds", "5", "--expected", "output includes: Export includes headers", "--criterion", "Export includes headers");
  assert.equal(added.status, 0, added.stderr);
  let state = await service.detail();
  const id = Object.keys(state.checks).find((key) => state.checks[key].value.taskId === "TASK-001")!;
  assert.equal(state.checks[id].value.timeoutSeconds, 5);
  assert.equal(cli(project, home, "checks", "run", id).status, 0);
  report = await checkReport(service, "TASK-001");
  assert.equal(report.rows.find((row) => row.id === id)?.status, "pass");
  assert.ok(report.rows.some((row) => row.phase === "baseline" && row.status === "fail"));
  const changed = await service.execute({ version: 1, kind: "check.put", expectedRevision: await service.revision(), payload: {
    id, taskId: "TASK-001", command, phase: "task", cwd: ".", timeoutSeconds: 5, expected: "output includes: absent", criterion: "Export includes headers" } });
  assert.equal(changed.subjectId, id);
  state = await service.detail();
  assert.equal(state.checks[id].history.length, 2);
  assert.equal(state.checks[id].results[0].status, "pass");
  assert.equal((await checkReport(service, "TASK-001")).rows.find((row) => row.id === id)?.status, "unrun");
  assert.notEqual(cli(project, home, "checks", "run", id).status, 0);
  assert.equal((await checkReport(service, "TASK-001")).rows.find((row) => row.id === id)?.status, "fail");
  const skipped = cli(project, home, "checks", "skip", id, "--reason", "Awaiting fixture");
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal((await checkReport(service, "TASK-001")).rows.find((row) => row.id === id)?.status, "skipped");
  assert.equal((await checkReport(service, "TASK-001")).counts.missing, 0);
  const timeoutCheck = await service.execute({ version: 1, kind: "check.put", expectedRevision: await service.revision(), payload: {
    taskId: "TASK-001", command: "node -e \"setTimeout(() => {}, 5000)\"", phase: "task", timeoutSeconds: 1, expected: "exit 0", criterion: "Command completes within a second" } });
  assert.notEqual(cli(project, home, "checks", "run", timeoutCheck.subjectId).status, 0);
  assert.match((await service.detail()).checks[timeoutCheck.subjectId].results.at(-1)?.reason ?? "", /Timed out/);
  const shared = JSON.stringify(await service.sharedView());
  assert.doesNotMatch(shared, /Export includes headers|Awaiting fixture|output includes/);
}));

test("[TASK-019] draft criteria generate focused executable and named review checks; edits invalidate prior evidence", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal((await checkReport(new CommandService(project))).rows.find((row) => row.id === "missing:baseline")?.status, "missing");
  await writeFile(join(project, "export.js"), "module.exports = { headers: ['name', 'age'] };\n");
  const artifact = "const test = require('node:test'); const assert = require('node:assert/strict'); const {join} = require('node:path'); test('Export includes headers', () => assert.deepEqual(require(join(process.cwd(), 'export.js')).headers, ['name', 'age']));\n";
  const task = { id: "TASK-101", description: "Export data", type: "test", difficulty: "hard", risk: "high", dependsOn: [],
    acceptanceCriteria: ["Export includes headers", "Export layout is readable"], areas: ["src/export"], workerProfile: "sol-high", context: ["README.md"],
    verification: ["command: node --test {{test:export.test.js}}", "review: Inspect sample export layout"], testArtifacts: [{ name: "export.test.js", content: artifact }] };
  await new PlanningWorkflow(project, { propose: async () => ({ questions: [], tasks: [task] }) }).start("Export data");
  const service = new CommandService(project);
  let report = await checkReport(service, task.id);
  assert.equal(report.counts.unrun, 2);
  assert.equal(report.counts.missing, 0);
  const executable = report.rows.find((row) => row.command)!;
  const review = report.rows.find((row) => row.procedure)!;
  assert.match(executable.command!, /plan-r1\/TASK-101\/export\.test\.js/);
  assert.equal(await readFile(join(project, ".orch", "generated-tests", "plan-r1", "TASK-101", "export.test.js"), "utf8"), artifact);
  assert.equal(cli(project, home, "checks", "run", executable.id).status, 0);
  assert.equal((await checkReport(service, task.id)).rows.find((row) => row.id === executable.id)?.status, "pass");
  await assert.rejects(service.execute({ version: 1, kind: "check.result", expectedRevision: await service.revision(), payload: { id: review.id, checkRevision: review.revision, status: "pass" } }), /named reviewer/);
  assert.equal(cli(project, home, "checks", "review", review.id, "--reviewer", "A. Reviewer").status, 0);
  report = await checkReport(service, task.id);
  assert.equal(report.counts.pass, 2);
  const state = await service.detail();
  await service.execute({ version: 1, kind: "plan.draft", expectedRevision: state.revision, payload: { tasks: [{ ...task, acceptanceCriteria: ["Export includes headers", "Export layout remains readable"], testArtifacts: [{ name: "export.test.js", content: `${artifact}// revised test\n` }] }] } });
  report = await checkReport(service, task.id);
  assert.equal(report.counts.pass, 0);
  assert.equal(report.counts.unrun, 2);
  assert.ok((await service.detail()).checks[executable.id].results.length === 1);
  assert.equal(await readFile(join(project, ".orch", "generated-tests", "plan-r1", "TASK-101", "export.test.js"), "utf8"), artifact);
  assert.match(await readFile(join(project, ".orch", "generated-tests", "plan-r2", "TASK-101", "export.test.js"), "utf8"), /revised test/);
  const local = await api<{ counts: { unrun: number } }>(project, home, "/api/checks?taskId=TASK-101");
  assert.equal(local.counts.unrun, 2);
}));

test("[TASK-018] consequential clarification yields an editable acyclic review draft without starting workers", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  let calls = 0;
  const tasks = [
    { id: "TASK-101", description: "Define the export contract", type: "analysis", difficulty: "moderate", risk: "medium", dependsOn: [],
      acceptanceCriteria: ["Contract names supported formats"], areas: ["src/export"], workerProfile: "luna-medium", context: ["README.md"], verification: ["Review format matrix"] },
    { id: "TASK-102", description: "Implement the export", type: "other", difficulty: "hard", risk: "high", dependsOn: ["TASK-101"],
      acceptanceCriteria: ["Export matches the contract"], areas: ["src/export"], workerProfile: "sol-high", context: ["Export contract"], verification: ["Run export tests"] },
  ];
  const model = { propose: async ({ answers }: { answers?: Record<string, string> }) => {
    calls++;
    return answers ? { questions: [], tasks } : { questions: [{ id: "format", question: "Which export format is required?", impact: "Changes parser dependencies and acceptance tests" }], tasks: [] };
  } };
  const workflow = new PlanningWorkflow(project, model);
  await workflow.start("Add export support");
  const service = new CommandService(project);
  let state = await service.detail();
  assert.equal(state.plan.value.draft?.status, "clarifying");
  assert.equal(state.plan.value.draft?.questions[0].impact, "Changes parser dependencies and acceptance tests");
  assert.deepEqual(state.tasks, []);
  await assert.rejects(service.execute({ version: 1, kind: "approval.grant", expectedRevision: state.revision,
    payload: { target: "plan", targetRevision: state.plan.revision, actor: "user" } }), /Answer planning questions/);
  await workflow.answer({ format: "CSV" }, state.revision);
  state = await service.detail();
  assert.equal(state.plan.value.draft?.status, "review");
  assert.deepEqual(state.plan.value.draft?.tasks[1].dependsOn, ["TASK-101"]);
  assert.equal(state.plan.value.draft?.tasks[1].acceptanceCriteria[0], "Export matches the contract");
  assert.deepEqual(state.tasks, []);
  assert.equal(calls, 2);
  const prior = state.plan.revision;
  await assert.rejects(service.execute({ version: 1, kind: "plan.draft", expectedRevision: state.revision, payload: { tasks: [{ ...tasks[0], dependsOn: ["TASK-102"] }, tasks[1]] } }), /Dependency cycle/);
  state = await service.detail();
  assert.equal(state.plan.revision, prior);
  await service.execute({ version: 1, kind: "plan.draft", expectedRevision: state.revision, payload: { tasks: [{ ...tasks[0], acceptanceCriteria: ["Contract names CSV fields"] }, tasks[1]] } });
  state = await service.detail();
  assert.equal(state.plan.revision, prior + 1);
  assert.equal(state.plan.value.draft?.tasks[0].acceptanceCriteria[0], "Contract names CSV fields");
  assert.deepEqual(state.tasks, []);
  const shown = cli(project, home, "draft", "show");
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Contract names CSV fields/);
  const local = await api<{ plan: { revision: number; value: { draft: { tasks: Array<{ id: string }> } } } }>(project, home, "/api/commands");
  assert.equal(local.plan.revision, state.plan.revision);
  assert.equal(local.plan.value.draft.tasks[0].id, "TASK-101");
  const run = cli(project, home, "run", "--once");
  assert.notEqual(run.status, 0);
  assert.deepEqual((await service.detail()).runs, {});
  assert.equal(cli(project, home, "draft", "approve").status, 0);
  assert.equal(JSON.parse(cli(project, home, "draft", "show").stdout).approved, true);
  state = await service.detail();
  await service.execute({ version: 1, kind: "plan.draft", expectedRevision: state.revision, payload: { tasks } });
  assert.equal(JSON.parse(cli(project, home, "draft", "show").stdout).approved, false);
  assert.notEqual(cli(project, home, "run", "--once").status, 0);
}));

async function fixture(work: (a: string, b: string, home: string) => Promise<void>) {
  const workspace = resolve(process.cwd());
  const root = await mkdtemp(join(workspace, ".orch-task-015-"));
  const a = join(root, "source");
  const b = join(root, "destination");
  const home = join(root, "home");
  try {
    await mkdir(a); await mkdir(b);
    await work(a, b, home);
  } finally {
    if (!resolve(root).startsWith(workspace + sep)) throw new Error("Fixture escaped workspace");
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function cli(project: string, home: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(__dirname, "cli.js"), ...args], {
    cwd: project, encoding: "utf8", env: { ...process.env, ORCH_HOME: home },
  });
}

async function api<T>(project: string, home: string, endpoint: string): Promise<T> {
  const previous = process.env.ORCH_HOME;
  process.env.ORCH_HOME = home;
  const server = createLocalApi(project);
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}${endpoint}`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body as T;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (previous === undefined) delete process.env.ORCH_HOME;
    else process.env.ORCH_HOME = previous;
  }
}

test("[TASK-015] migrated evidence stays private while a reviewed lesson crosses projects and candidates deduplicate", async () => fixture(async (source, destination, home) => {
  for (const project of [source, destination]) {
    assert.equal(cli(project, home, "init").status, 0);
    assert.equal(cli(project, home, "plan", "Rename public type references", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
  }
  const legacy = [
    { kind: "note", at: "2025-01-01T00:00:00.000Z", text: "Private source detail for local review" },
    { kind: "attempt", at: "2025-01-02T00:00:00.000Z", taskId: "TASK-001", taskType: "rename", difficulty: "easy", risk: "low", route: "luna-low", model: "codex:gpt-6-luna", passed: true, errors: [], simulated: false, inputTokens: 17, outputTokens: 3 },
  ];
  const legacyPath = join(source, ".orch", "knowledge.jsonl");
  const original = legacy.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(legacyPath, original);
  const from = new KnowledgeStore(source, home);
  const to = new KnowledgeStore(destination, home);
  assert.equal((await from.list("project")).length, 2);
  assert.equal((await from.list("project")).length, 2);
  assert.equal(await readFile(legacyPath, "utf8"), original);
  const privateNote = await from.note("project", "Run C:/private/repo/check.ps1 for this rename", "rename");
  assert.equal(cli(source, home, "knowledge", "review", privateNote.id, "--status", "approved").status, 0);
  assert.notEqual(cli(source, home, "knowledge", "promote", privateNote.id).status, 0);
  const shared = await from.note("project", "For renames, inspect public references", "rename");
  assert.equal(cli(source, home, "knowledge", "review", shared.id, "--status", "approved").status, 0);
  assert.equal(cli(source, home, "knowledge", "promote", shared.id).status, 0);
  const global = JSON.parse(cli(destination, home, "knowledge", "export", "--scope", "global").stdout) as { entries: Array<{ id: string; sourceEntryId: string }> };
  assert.equal(global.entries.length, 1);
  assert.equal(global.entries[0].sourceEntryId, shared.id);
  assert.doesNotMatch(JSON.stringify(global), /Private source detail|private\/repo|check\.ps1|TASK-001|inputTokens/);
  assert.equal((await to.list("project")).length, 0);
  const retrieved = await to.retrieve({ id: "TASK-001", description: "Rename public type references", type: "rename", difficulty: "easy", risk: "low", dependsOn: [] });
  assert.deepEqual(retrieved.map(({ entry }) => entry.id), [global.entries[0].id]);
  assert.match(retrieved[0].reason, /category rename/);

  const task: TaskSpec = { id: "TASK-001", description: "Rename public type references", type: "rename", difficulty: "easy", risk: "low", dependsOn: [] };
  const outcome = { attempt: 1, route: routeTask(task), model: "codex:gpt-6-luna", validation: { passed: true, errors: [] }, inputTokens: 10, outputTokens: 2, latencyMs: 100 };
  await to.recordAttempt("project", task, outcome, true, "simulation");
  await to.recordAttempt("project", task, outcome, false, "live-1");
  await to.recordAttempt("project", task, outcome, false, "live-1");
  await to.recordAttempt("project", task, outcome, false, "live-2");
  const entries = await to.list("project");
  const candidates = entries.filter((entry) => entry.kind === "candidate");
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].evidence.map(({ runId }) => runId), ["live-1", "live-2"]);
  assert.equal(entries.filter((entry) => entry.kind === "attempt").length, 3);
  const knowledge = await api<{ lessons: Array<{ id: string }>; candidates: Array<{ id: string }>; retrieval: Array<{ selections: Array<{ id: string }> }> }>(destination, home, "/api/knowledge");
  assert.deepEqual(knowledge.lessons.map(({ id }) => id), [global.entries[0].id]);
  assert.deepEqual(knowledge.candidates.map(({ id }) => id), [candidates[0].id]);
  assert.deepEqual(knowledge.retrieval[0].selections.map(({ id }) => id), [global.entries[0].id]);
  const history = await api<{ attempts: AttemptEntry[] }>(destination, home, "/api/history");
  assert.equal(history.attempts.filter((entry) => entry.simulated).length, 1);
  assert.equal(history.attempts.filter((entry) => !entry.simulated).length, 2);
}));

test("[TASK-015] legacy model settings, weighted choice, manual override, fallback, and simulated filtering agree across CLI and API", async () => fixture(async (_source, project, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "Analyze route evidence", "--type", "analysis", "--difficulty", "moderate", "--risk", "medium").status, 0);
  const registryPath = join(project, ".orch", "models.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, policyVersion: 7, models: [
    { alias: "sol-medium", provider: "codex", model: "gpt-6-sol", tier: "sol-medium", effort: "medium", enabled: true, weight: 1 },
    { alias: "preferred-sol", provider: "codex", model: "gpt-6-sol", tier: "sol-medium", effort: "medium", enabled: true, weight: 8 },
    { alias: "luna-medium", provider: "codex", model: "gpt-6-luna", tier: "luna-medium", effort: "medium", enabled: true, weight: 1 },
  ] }));
  const loaded = await loadRegistry(project);
  assert.equal(loaded.policyVersion, 7);
  assert.equal(selectModel(loaded, { worker: "sol", effort: "medium", label: "sol-medium" }).alias, "preferred-sol");
  assert.equal(loaded.models.find((model) => model.tier === "luna-high")?.effort, "high");
  assert.match(cli(project, home, "models", "list").stdout, /preferred-sol.*weight=8/);
  const store = new KnowledgeStore(project, home);
  for (const route of ["sol-medium", "luna-medium"] as const) {
    for (let index = 0; index < 8; index += 1) {
      await store.append("project", { kind: "attempt", id: `${route}-${index}`, scope: "project", sourceProject: "fixture", sourceRunId: `run-${route}-${index}`,
        at: "2026-01-01T00:00:00.000Z", taskId: `HIST-${route}-${index}`, attemptNumber: 1, taskType: "analysis", difficulty: "moderate", risk: "medium",
        route, model: route === "sol-medium" ? "codex:gpt-6-sol" : "codex:gpt-6-luna", passed: true, errors: [], simulated: false,
        inputTokens: 1000, outputTokens: 100, latencyMs: 1000 } as AttemptEntry);
    }
  }
  for (let index = 0; index < 20; index += 1) {
    await store.append("project", { kind: "attempt", id: `fake-${index}`, scope: "project", sourceProject: "fixture", sourceRunId: `fake-${index}`,
      at: "2026-01-01T00:00:00.000Z", taskId: `FAKE-${index}`, taskType: "analysis", difficulty: "moderate", risk: "medium",
      route: "luna-medium", model: "codex:gpt-6-luna", passed: false, errors: ["simulated"], simulated: true,
      inputTokens: 1000, outputTokens: 100, latencyMs: 1000 } as AttemptEntry);
  }
  const prices = { version: "fixture-reviewed", currency: "USD", models: {
    "codex:gpt-6-sol": { inputPerMillion: 10, outputPerMillion: 20 },
    "codex:gpt-6-luna": { inputPerMillion: 1, outputPerMillion: 2 },
  } };
  const pricePath = join(project, ".orch", "prices.json");
  await writeFile(pricePath, JSON.stringify(prices));
  const command = cli(project, home, "models", "recommend", "TASK-001", "--prices", pricePath);
  assert.equal(command.status, 0, command.stderr);
  const proposal = JSON.parse(command.stdout);
  assert.equal(proposal.chosenAlias, "preferred-sol");
  assert.equal(proposal.fallbackAlias, "preferred-sol");
  assert.equal(proposal.recommendedAlias, "luna-medium");
  assert.equal(proposal.candidate.taskCount, 8);
  assert.equal(proposal.candidate.validatedPasses, 8);
  const apiProposal = await api<{ proposals: Array<{ proposal: typeof proposal }> }>(project, home, "/api/model-proposals");
  assert.deepEqual(apiProposal.proposals[0].proposal, proposal);
  const models = await api<{ observations: Array<{ alias: string; liveAttempts: number }> }>(project, home, "/api/models");
  assert.equal(models.observations.find((item) => item.alias === "luna-medium")?.liveAttempts, 8);
  const manual = cli(project, home, "models", "recommend", "TASK-001", "--prices", pricePath, "--manual-alias", "luna-medium");
  assert.equal(manual.status, 0, manual.stderr);
  assert.equal(JSON.parse(manual.stdout).chosenAlias, "luna-medium");
  assert.equal(JSON.parse(manual.stdout).fallbackAlias, "preferred-sol");
  assert.equal(JSON.parse(manual.stdout).recommendedAlias, undefined);
  assert.equal((await loadRegistry(project)).policyVersion, 7);
  const noPrice = cli(project, home, "models", "recommend", "TASK-001");
  assert.equal(JSON.parse(noPrice.stdout).fallbackAlias, "preferred-sol");
  assert.equal(JSON.parse(noPrice.stdout).recommendedAlias, undefined);
}));

test("[TASK-016] CLI and local API apply versioned commands with matching audit IDs, reject stale revisions, and keep detail private", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  const service = new CommandService(project);
  const firstRevision = await service.revision();
  const privateDescription = `Refactor private detail at ${join(project, "src", "secret.ts")}`;
  const command = { version: 1 as const, kind: "plan.add" as const, expectedRevision: firstRevision,
    payload: { description: privateDescription, type: "refactor", difficulty: "hard", risk: "high", dependsOn: [] } };
  const cliResult = cli(project, home, "command", "--json", JSON.stringify(command));
  assert.equal(cliResult.status, 0, cliResult.stderr);
  const added = JSON.parse(cliResult.stdout) as { revision: number; auditId: string; subjectId: string };
  assert.equal(added.revision, firstRevision + 1);
  assert.equal(added.subjectId, "TASK-001");
  const detail = await service.detail();
  assert.equal(detail.tasks[0].spec.description, privateDescription);
  assert.equal(detail.audit.at(-1)?.id, added.auditId);

  const server = createLocalApi(project);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (body: unknown) => fetch(`${base}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const stale = await post(command);
    assert.equal(stale.status, 409);
    assert.match(JSON.stringify(await stale.json()), /Stale revision/);
    assert.equal((await fetch(`${base}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.invalid" }, body: JSON.stringify(command) })).status, 403);
    const checkCommand = `node ${join(project, "private-check.js")}`;
    const updated = await post({ version: 1, kind: "check.put", expectedRevision: added.revision,
      payload: { taskId: "TASK-001", command: checkCommand, phase: "task", timeoutSeconds: 60, expected: "pass" } });
    assert.equal(updated.status, 200);
    const apiResult = await updated.json() as { revision: number; auditId: string; subjectId: string };
    assert.equal(apiResult.revision, added.revision + 1);
    assert.equal((await service.detail()).audit.at(-1)?.id, apiResult.auditId);
    await assert.rejects(service.execute({ version: 1, kind: "approval.grant", expectedRevision: apiResult.revision,
      payload: { target: "checks", targetRevision: 2, actor: "user" } }), /Stale checks approval/);
    const approval = await service.execute({ version: 1, kind: "approval.grant", expectedRevision: apiResult.revision,
      payload: { target: "checks", targetRevision: 1, actor: "user" } });
    const policy = await service.execute({ version: 1, kind: "policy.put", expectedRevision: approval.revision,
      payload: { rules: { privateRule: join(project, "architecture.md") } } });
    const run = await service.execute({ version: 1, kind: "run.record", expectedRevision: policy.revision,
      payload: { runId: "123e4567-e89b-42d3-a456-426614174000", status: "running", mode: "simulated" } });
    assert.equal((await service.detail()).runs["123e4567-e89b-42d3-a456-426614174000"].revision, 1);
    assert.equal((await service.detail()).audit.at(-1)?.id, run.auditId);
    const modelChange = cli(project, home, "models", "weight", "luna-low", "2");
    assert.equal(modelChange.status, 0, modelChange.stderr);
    assert.equal((await service.detail()).audit.at(-1)?.kind, "policy.model");
    assert.equal((await loadRegistry(project)).models.find((model) => model.alias === "luna-low")?.weight, 2);
    const shared = await (await fetch(`${base}/api/commands/shared`)).text();
    assert.deepEqual(JSON.parse(shared), await service.sharedView());
    assert.doesNotMatch(shared, /Refactor private|secret\.ts|private-check|architecture\.md|src[\\/]|check\.put.*node/);
    assert.doesNotMatch(shared, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(JSON.stringify(await service.detail()), /private-check/);
    assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
    assert.equal((await fetch(`${base}/api/tasks`, { method: "POST" })).status, 405);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}));

test("[TASK-016] an existing task file gains a stable command identity without changing its graph", async () => fixture(async (project, _other, home) => {
  await mkdir(join(project, ".orch"));
  const existing = { tasks: [{ spec: { id: "TASK-007", description: "Existing work", type: "analysis", difficulty: "moderate", risk: "medium", dependsOn: [] }, status: "pending", attempts: [] }] };
  await writeFile(join(project, ".orch", "tasks.json"), JSON.stringify(existing));
  const service = new CommandService(project);
  const first = await service.sharedView() as { projectId: string; revision: number };
  const second = await service.sharedView() as { projectId: string; revision: number };
  assert.equal(first.projectId, second.projectId);
  assert.equal(first.revision, second.revision);
  assert.deepEqual(JSON.parse(await readFile(join(project, ".orch", "tasks.json"), "utf8")), existing);
  assert.match(cli(project, home, "status").stdout, /TASK-007  ready/);
  assert.equal(cli(project, home, "plan", "New work", "--after", "TASK-007").status, 0);
  assert.deepEqual((await service.detail()).tasks.map((task) => task.spec.id), ["TASK-007", "TASK-008"]);
}));

test("[TASK-017] CLI and UI service register one Git project, version context documents, and export only opaque metadata", async () => fixture(async (project, _other, home) => {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init");
  await writeFile(join(project, "README.md"), "Private product design for a hidden feature\n");
  await writeFile(join(project, "ARCHITECTURE.md"), "Private source architecture\n");
  await writeFile(join(project, "package.json"), JSON.stringify({ scripts: { test: "node private-check.js" } }));
  git("add", ".");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial fixture");
  const first = cli(project, home, "init", "--docs", "README.md");
  assert.equal(first.status, 0, first.stderr);
  const service = new CommandService(project);
  const initial = await service.detail();
  assert.match(initial.project.value.id, /^[0-9a-f-]{36}$/);
  assert.equal(initial.project.value.git?.isRepository, true);
  assert.equal(initial.project.value.git?.head?.length, 40);
  assert.equal(initial.project.value.scripts?.test, "node private-check.js");
  assert.deepEqual(initial.project.value.context, { version: 1, documents: ["README.md"] });
  const second = cli(project, home, "init", "--docs", "README.md");
  assert.equal(second.status, 0, second.stderr);
  assert.equal((await service.detail()).revision, initial.revision);

  const server = createLocalApi(project);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/project/register`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents: ["README.md", "ARCHITECTURE.md"] }) });
    assert.equal(response.status, 200);
    const registered = await response.json() as { id: string; revision: number; context: { version: number; documents: string[] } };
    assert.equal(registered.id, initial.project.value.id);
    assert.equal(registered.context.version, 2);
    assert.equal(registered.revision, initial.project.revision + 1);
    assert.deepEqual(registered.context.documents, ["README.md", "ARCHITECTURE.md"]);
    const shared = await (await fetch(`${base}/api/commands/shared`)).text();
    assert.equal(JSON.parse(shared).projectId, registered.id);
    assert.equal(JSON.parse(shared).records.context, 2);
    assert.doesNotMatch(shared, /README|ARCHITECTURE|Private|private-check|package\.json|source|product/i);
    assert.equal(shared.includes(project), false);
    const invalid = await fetch(`${base}/api/project/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documents: ["../outside.md"] }) });
    assert.equal(invalid.status, 400);
    assert.equal((await service.detail()).project.value.context?.version, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}));

test("[TASK-017] local UI API registers a previously uninitialized directory", async () => fixture(async (project) => {
  await writeFile(join(project, "README.md"), "Local onboarding context\n");
  const server = createLocalApi(project);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const before = await (await fetch(`${base}/api/project`)).json() as { registered: boolean };
    assert.equal(before.registered, false);
    const response = await fetch(`${base}/api/project/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documents: ["README.md"] }) });
    assert.equal(response.status, 200);
    const after = await (await fetch(`${base}/api/project`)).json() as { registered: boolean; project: { value: { context: { version: number } } } };
    assert.equal(after.registered, true);
    assert.equal(after.project.value.context.version, 1);
    assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}));

test("[TASK-023] local run projection allows metadata and rejects private or unexpected fields", async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  const privateText = "Private product architecture prompt and source diff at C:\\secret\\src\\index.ts";
  assert.equal(cli(project, home, "plan", privateText, "--type", "refactor", "--risk", "high").status, 0);
  assert.equal(cli(project, home, "run", "--once").status, 0);
  const eventFile = join(project, ".orch", "runs.jsonl");
  const events = (await readFile(eventFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, any>);
  const finished = events.find((event) => event.type === "attempt.finished");
  assert.ok(finished);
  finished.attempt.response = privateText;
  finished.attempt.checkOutput = privateText;
  finished.rawWorkerOutput = privateText;
  await writeFile(eventFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const snapshot = await localSharedSnapshot(project);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].tasks[0].category, "refactor");
  assert.equal(snapshot.runs[0].tasks[0].risk, "high");
  assert.equal(snapshot.runs[0].attempts[0].passed, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /Private|architecture|prompt|source|diff|secret|index\.ts/i);
  const local = await api<Record<string, any>>(project, home, "/api/commands");
  assert.equal(local.tasks[0].spec.description, privateText);
  const localEvents = await api<Record<string, any>>(project, home, `/api/runs/${snapshot.runs[0].runId}/events`);
  assert.match(JSON.stringify(localEvents), /rawWorkerOutput/);
  const shared = await api<Record<string, any>>(project, home, "/api/shared/runs");
  assert.deepEqual(shared, snapshot);
  const rejects = [
    { ...snapshot, unexpected: { path: privateText } },
    { ...snapshot, runs: [{ ...snapshot.runs[0], prompt: privateText }] },
    { ...snapshot, runs: [{ ...snapshot.runs[0], tasks: [{ ...snapshot.runs[0].tasks[0], source: privateText }] }] },
    { ...snapshot, runs: [{ ...snapshot.runs[0], attempts: [{ ...snapshot.runs[0].attempts[0], rawOutput: privateText }] }] },
    { ...snapshot, runs: [{ ...snapshot.runs[0], attempts: [{ ...snapshot.runs[0].attempts[0], model: privateText }] }] },
  ];
  const database = new PostgresMetadata();
  for (const payload of rejects) {
    assert.throws(() => validateSharedSnapshot(payload), /Unknown|Invalid/);
    await assert.rejects(database.sync(payload), /Unknown|Invalid/);
  }
}));

test("[TASK-023] fresh Docker Postgres migrates and round-trips allowed run metadata", { skip: process.env.ORCH_TEST_POSTGRES !== "1" }, async () => fixture(async (project, _other, home) => {
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "A private task").status, 0);
  assert.equal(cli(project, home, "run", "--once").status, 0);
  const snapshot = await localSharedSnapshot(project);
  const compose = join(__dirname, "..", "compose.yaml");
  const name = `orch023${process.pid}`;
  const docker = (...args: string[]) => spawnSync("docker", ["compose", "-f", compose, "-p", name, ...args], { encoding: "utf8", timeout: 120_000 });
  const started = docker("up", "-d", "--wait");
  assert.equal(started.status, 0, started.stderr);
  try {
    const store = new PostgresMetadata(name);
    await store.migrate();
    await store.migrate();
    await store.sync(snapshot);
    await store.sync(snapshot);
    const rows = await store.runs(snapshot.projectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, snapshot.runs[0].runId);
    assert.equal(rows[0].mode, "simulated");
    assert.equal((rows[0].tasks as unknown[]).length, 1);
    assert.equal((rows[0].attempts as unknown[]).length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private task/i);
  } finally {
    const stopped = docker("down", "-v");
    assert.equal(stopped.status, 0, stopped.stderr);
  }
}));
