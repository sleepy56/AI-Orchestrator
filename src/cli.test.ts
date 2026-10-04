import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskSnapshot } from "./types";

const cliPath = join(__dirname, "cli.js");

function orch(project: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: project,
    encoding: "utf8",
  });
}

test("CLI initializes, plans a graph, runs fake workers, and reports status", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-"));
  try {
    assert.match(orch(project, "status").stderr, /Run orch init first/);
    assert.equal(orch(project, "init").status, 0);
    assert.match(orch(project, "init").stdout, /Already initialized/);

    const sentinel = join(project, "app.txt");
    await writeFile(sentinel, "unchanged", "utf8");
    assert.equal(orch(project, "plan", "Rename UserGoal to Goal", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
    assert.equal(orch(project, "plan", "Run T2", "--after", "TASK-001").status, 0);
    assert.equal(orch(project, "plan", "Run T3", "--after", "TASK-001").status, 0);
    assert.equal(orch(project, "plan", "Run T4", "--after", "TASK-002,TASK-003").status, 0);

    const before = orch(project, "status");
    assert.match(before.stdout, /TASK-001  ready/);
    assert.match(before.stdout, /TASK-004  blocked/);
    assert.match(orch(tmpdir(), "status", "--project", project).stdout, /TASK-004  blocked/);

    const run = orch(project, "run");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Batch 1: TASK-001/);
    assert.match(run.stdout, /Batch 2: TASK-002 \+ TASK-003/);
    assert.match(run.stdout, /Batch 3: TASK-004/);
    assert.match(run.stdout, /TASK-001: fake luna-low attempt 1/);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");

    const snapshot = JSON.parse(await readFile(join(project, ".orch", "tasks.json"), "utf8")) as TaskSnapshot;
    assert.deepEqual(snapshot.tasks.map((record) => record.status), [
      "completed", "completed", "completed", "completed",
    ]);
    assert.match(orch(project, "status").stdout, /TASK-004  completed/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("CLI rejects invalid dependencies without changing the plan", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-"));
  try {
    assert.equal(orch(project, "init").status, 0);
    const target = join(project, ".orch", "tasks.json");
    const before = await readFile(target, "utf8");
    const result = orch(project, "plan", "Blocked task", "--after", "TASK-999");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown dependency/);
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("CLI installs the packaged Codex skill without overwriting by default", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-"));
  try {
    const destination = join(project, "skills");
    assert.equal(orch(project, "skill", "install", "--to", destination).status, 0);
    const target = join(destination, "orch", "SKILL.md");
    assert.match(await readFile(target, "utf8"), /name: orch/);
    assert.match(orch(project, "skill", "install", "--to", destination).stdout, /already current/);
    await writeFile(target, "custom skill", "utf8");
    assert.match(orch(project, "skill", "install", "--to", destination).stderr, /--force/);
    assert.equal(await readFile(target, "utf8"), "custom skill");
    assert.equal(orch(project, "skill", "install", "--to", destination, "--force").status, 0);
    assert.match(await readFile(target, "utf8"), /name: orch/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("CLI manages models and knowledge while keeping live execution opt-in", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-"));
  try {
    assert.equal(orch(project, "init").status, 0);
    assert.match(orch(project, "models", "list").stdout, /claude-placeholder.*disabled/);
    assert.equal(orch(project, "models", "add", "luna-alt", "--model", "custom-luna", "--tier", "luna-low", "--effort", "low", "--weight", "3", "--enable").status, 0);
    assert.match(orch(project, "models", "list").stdout, /luna-alt.*enabled.*weight=3/);
    assert.match(orch(project, "models", "enable", "claude-placeholder").stderr, /Claude execution is unavailable/);
    assert.equal(orch(project, "knowledge", "add", "Use the project test suite").status, 0);
    assert.match(orch(project, "knowledge", "list").stdout, /Use the project test suite/);
    assert.equal(orch(project, "plan", "Rename a type", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
    const refused = orch(project, "run", "--executor", "codex");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /require --check/);
    assert.match(orch(project, "status").stdout, /TASK-001  ready/);
    assert.equal(orch(project, "run").status, 0);
    assert.match(orch(project, "history").stdout, /TASK-001.*luna-low.*passed.*fake/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("CLI requires explicit retry after an interrupted run", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-"));
  try {
    assert.equal(orch(project, "init").status, 0);
    assert.equal(orch(project, "plan", "Create a file").status, 0);
    const target = join(project, ".orch", "tasks.json");
    const snapshot = JSON.parse(await readFile(target, "utf8")) as TaskSnapshot;
    snapshot.tasks[0].status = "running";
    await writeFile(target, JSON.stringify(snapshot), "utf8");
    assert.match(orch(project, "run").stderr, /orch retry/);
    assert.equal(orch(project, "retry", "TASK-001").status, 0);
    assert.match(orch(project, "status").stdout, /TASK-001  ready/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
