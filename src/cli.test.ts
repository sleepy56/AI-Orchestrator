import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeStore } from "./knowledge";
import { routeTask } from "./router";
import { TaskSnapshot } from "./types";

const cliPath = join(__dirname, "cli.js");

test("CLI shows candidate evidence and approval creates one reviewed lesson", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-candidate-"));
  try {
    assert.equal(orch(project, "init").status, 0);
    const store = new KnowledgeStore(project, join(project, "global"));
    const task = { id: "TASK-001", description: "Rename a type", type: "rename" as const, difficulty: "easy" as const, risk: "low" as const, dependsOn: [] };
    await store.recordAttempt("project", task, { attempt: 1, route: routeTask(task), validation: { passed: true, errors: [] } }, false, "live-run-1");
    const candidate = (await store.list("project")).find((entry) => entry.kind === "candidate");
    assert.ok(candidate);
    const listed = orch(project, "knowledge", "list");
    assert.match(listed.stdout, new RegExp(`${candidate.id}.*pending.*candidate.*live-run-1`));
    assert.equal(orch(project, "knowledge", "review", candidate.id, "--status", "approved").status, 0);
    const entries = await store.list("project");
    assert.equal(entries.filter((entry) => entry.kind === "note" && entry.reviewStatus === "approved").length, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

function orch(project: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, ORCH_HOME: join(project, "global") },
  });
}

test("CLI knowledge review and promotion keep private details local with an audit trail", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-review-"));
  try {
    assert.equal(orch(project, "init").status, 0);
    assert.notEqual(orch(project, "knowledge", "add", "Direct global note", "--scope", "global").status, 0);
    assert.equal(orch(project, "knowledge", "add", "Run C:/repo/private/check.ps1", "--type", "test").status, 0);
    const id = orch(project, "knowledge", "list").stdout.match(/[0-9a-f-]{36}/)?.[0];
    assert.ok(id);
    assert.notEqual(orch(project, "knowledge", "promote", id).status, 0);
    assert.equal(orch(project, "knowledge", "review", id, "--status", "approved").status, 0);
    assert.notEqual(orch(project, "knowledge", "promote", id).status, 0);
    assert.equal(orch(project, "knowledge", "edit", id, "For tests, verify public behavior").status, 0);
    assert.notEqual(orch(project, "knowledge", "promote", id).status, 0);
    assert.equal(orch(project, "knowledge", "review", id, "--status", "approved").status, 0);
    assert.equal(orch(project, "knowledge", "promote", id).status, 0);
    const global = orch(project, "knowledge", "export", "--scope", "global");
    assert.equal(global.status, 0);
    const exported = JSON.parse(global.stdout);
    assert.equal(exported.entries[0].sourceEntryId, id);
    assert.doesNotMatch(global.stdout, /check\.ps1|C:\/repo/);
    assert.equal(orch(project, "knowledge", "remove", exported.entries[0].id, "--scope", "global").status, 0);
    const after = JSON.parse(orch(project, "knowledge", "export", "--scope", "global").stdout);
    assert.deepEqual(after.entries, []);
    assert.deepEqual(after.audit.map((event: { action: string }) => event.action), ["promote", "remove"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

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

test("IMP-TASK-001 preflight validates context at the pinned commit before creating workers", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-second-repo-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", `safe.directory=${project.replace(/\\/g, "/")}`, "-C", project, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init");
    await writeFile(join(project, "README.md"), "tracked context\n");
    git("add", "README.md");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
    const branch = git("branch", "--show-current");
    const head = git("rev-parse", "HEAD");
    await writeFile(join(project, "local.md"), "untracked context\n");
    assert.equal(orch(project, "init", "--docs", "local.md").status, 0);
    assert.equal(orch(project, "plan", "Small change").status, 0);
    const stateBeforePreflight = await readFile(join(project, ".orch", "commands.v1.json"), "utf8");
    const before = JSON.parse(orch(project, "preflight", "--executor", "codex").stdout);
    assert.equal(await readFile(join(project, ".orch", "commands.v1.json"), "utf8"), stateBeforePreflight);
    assert.equal(before.directory, project);
    assert.equal(before.git.branch, branch);
    assert.equal(before.git.head, head);
    assert.equal(before.git.dirty, true);
    assert.equal(before.mode, "live");
    assert.deepEqual(before.context.unavailable, ["local.md"]);
    assert.ok(before.blockers.some((item: string) => item.includes("approved worktree base")));
    assert.ok(before.blockers.some((item: string) => item.includes("require --check")));
    assert.match(before.nextAction, /Track the listed context files/);
    const rejected = orch(project, "worktrees", "base", branch, head);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /local\.md/);
    assert.equal((await stat(join(project, ".orch", "worktrees.json")).then(() => true, () => false)), false);
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    assert.equal(orch(project, "init", "--docs", "README.md").status, 0);
    assert.equal(orch(project, "worktrees", "base", branch, head).status, 0);
    const configured = JSON.parse(orch(project, "preflight", "--executor", "codex").stdout);
    assert.equal(configured.approvedBase.commit, head);
    assert.deepEqual(configured.context.unavailable, []);
    assert.deepEqual(configured.context.documents, ["README.md"]);
    assert.ok(configured.provider.enabledModels.length);
    assert.ok(configured.blockers.some((item: string) => item.includes("require --check")));
    const missingCheck = orch(project, "run", "--executor", "codex");
    assert.equal(missingCheck.status, 1);
    assert.match(missingCheck.stderr, /require --check/);
    assert.equal((await stat(join(project, ".orch", "worktrees.json")).then(() => true, () => false)), false);
    for (const alias of configured.provider.enabledModels) assert.equal(orch(project, "models", "disable", alias).status, 0);
    const disabled = JSON.parse(orch(project, "preflight", "--executor", "codex", "--check", "npm test").stdout);
    assert.deepEqual(disabled.provider.enabledModels, []);
    assert.deepEqual(disabled.verification, ["npm test"]);
    assert.ok(disabled.blockers.some((item: string) => item.includes("No enabled executable")));
    assert.match(disabled.nextAction, /Configure an enabled Codex model/);
    assert.equal(orch(project, "run", "--executor", "codex", "--check", "npm test").status, 1);
    assert.equal((await stat(join(project, ".orch", "worktrees.json")).then(() => true, () => false)), false);
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    const simulated = JSON.parse(orch(project, "preflight").stdout);
    assert.equal(simulated.mode, "simulated");
    assert.deepEqual(simulated.blockers, []);
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
    const listed = orch(project, "models", "list").stdout;
    for (const effort of ["low", "medium", "high"]) {
      assert.match(listed, new RegExp(`luna-${effort}  codex  gpt-6-luna  luna-${effort}  ${effort}  enabled`));
    }
    assert.equal(orch(project, "models", "add", "luna-alt", "--model", "custom-luna", "--tier", "luna-low", "--effort", "low", "--weight", "3", "--enable").status, 0);
    assert.match(orch(project, "models", "list").stdout, /luna-alt.*enabled.*weight=3/);
    assert.match(orch(project, "models", "enable", "claude-placeholder").stderr, /Claude execution is unavailable/);
    assert.equal(orch(project, "knowledge", "add", "Use the project test suite", "--type", "test").status, 0);
    assert.match(orch(project, "knowledge", "list").stdout, /Use the project test suite/);
    const knowledge = JSON.parse(await readFile(join(project, ".orch", "knowledge.v1.json"), "utf8"));
    assert.equal(knowledge.entries[0].taskCategory, "test");
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

test("CLI --once advances exactly one task and accepts a bounded timeout", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-"));
  try {
    assert.equal(orch(project, "init").status, 0);
    assert.equal(orch(project, "plan", "First task").status, 0);
    assert.equal(orch(project, "plan", "Second task", "--after", "TASK-001").status, 0);
    assert.equal(orch(project, "plan", "Third task", "--after", "TASK-002").status, 0);
    const run = orch(project, "run", "--once", "--timeout-seconds", "30");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /TASK-001: completed/);
    assert.match(orch(project, "status").stdout, /TASK-002  ready/);
    assert.match(orch(project, "status").stdout, /TASK-003  blocked/);
    assert.match(orch(project, "run", "--once", "--timeout-seconds", "0").stderr, /integer from 1 to 3600/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("CLI doctor rejects an invalid timeout without changing task state", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-cli-"));
  try {
    assert.equal(orch(project, "init").status, 0);
    assert.equal(orch(project, "plan", "Pending task").status, 0);
    const target = join(project, ".orch", "tasks.json");
    const before = await readFile(target, "utf8");
    const result = orch(project, "doctor", "codex", "--timeout-seconds", "0");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /integer from 1 to 3600/);
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("IMP-TASK-001 pinned symlinks and moved bases on another visible branch remain blocked", async () => {
  const project = await mkdtemp(join(tmpdir(), "orch-base-preflight-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", `safe.directory=${project.replace(/\\/g, "/")}`, "-C", project, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "-b", "main");
    await writeFile(join(project, "README.md"), "Local regular context\n");
    git("add", "README.md");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "regular base");
    const originalBase = git("rev-parse", "HEAD");
    assert.equal(orch(project, "init", "--docs", "README.md").status, 0);
    assert.equal(orch(project, "plan", "Small change").status, 0);
    assert.equal(orch(project, "worktrees", "base", "main", originalBase).status, 0);

    await writeFile(join(project, ".orch", "symlink-target"), "/outside/context.md\n");
    const object = git("hash-object", "-w", ".orch/symlink-target");
    git("update-index", "--cacheinfo", `120000,${object},README.md`);
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "pinned symlink");
    const symlinkBase = git("rev-parse", "HEAD");
    assert.equal(await readFile(join(project, "README.md"), "utf8"), "Local regular context\n");
    const symlinkApproval = orch(project, "worktrees", "base", "main", symlinkBase);
    assert.equal(symlinkApproval.status, 1);
    assert.match(symlinkApproval.stderr, /Pinned context unavailable.*README\.md/);
    assert.equal((await stat(join(project, ".orch", "worktrees.json")).then(() => true, () => false)), false);

    git("reset", "--mixed", originalBase);
    git("checkout", "-b", "other");
    await writeFile(join(project, "README.md"), "Changed regular context\n");
    git("add", "README.md");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "move approved branch");
    git("update-ref", "refs/heads/main", git("rev-parse", "HEAD"));
    const moved = JSON.parse(orch(project, "preflight", "--executor", "codex", "--check", "npm test").stdout);
    assert.equal(moved.git.branch, "other");
    assert.ok(moved.blockers.includes("Approved base branch has moved"));
    const refused = orch(project, "run", "--executor", "codex", "--check", "npm test");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Approved base branch has moved/);
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
