import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeStore } from "./knowledge";
import { defaultRegistry, selectModel, validateProfile } from "./models";
import { routeTask } from "./router";
import { TaskSpec } from "./types";

test("project notes and global notes stay separate; attempts retain useful routing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-knowledge-"));
  try {
    const store = new KnowledgeStore(join(root, "project"), join(root, "global"));
    await store.note("project", "Use npm test for this repository");
    const reusable = await store.note("project", "Prefer low effort for simple renames");
    await store.review(reusable.id, "approved");
    await store.promote(reusable.id);
    const task: TaskSpec = { id: "TASK-001", description: "Rename a type", type: "rename", difficulty: "easy", risk: "low", dependsOn: [] };
    await store.recordAttempt("project", task, { attempt: 1, route: routeTask(task), validation: { passed: true, errors: [] }, model: "codex:gpt-6-luna", inputTokens: 10, outputTokens: 5 }, false);
    await assert.rejects(store.recordAttempt("global", task, { attempt: 2, route: routeTask(task), validation: { passed: false, errors: ["private path" ] }, checkCommand: "private check", model: "codex:gpt-6-luna" }, false), /stay in project/);
    const project = await store.list("project");
    const global = await store.list("global");
    assert.equal(project.length, 3);
    assert.equal(global.length, 1);
    assert.equal(project[0].kind, "note");
    if (project[0].kind === "note") {
      assert.match(project[0].id, /^[0-9a-f-]{36}$/);
      assert.equal(project[0].scope, "project");
      assert.match(project[0].sourceProject ?? "", /^project-/);
      assert.equal(project[0].sourceRunId, null);
      assert.equal(project[0].taskCategory, "other");
      assert.equal(project[0].reviewStatus, "pending");
      assert.equal(project[0].createdAt, project[0].updatedAt);
    }
    assert.equal(project[2].kind, "attempt");
    if (project[2].kind === "attempt") {
      assert.equal(project[2].model, "codex:gpt-6-luna");
      assert.equal(project[2].inputTokens, 10);
      assert.equal(project[2].simulated, false);
    }
    assert.equal(global[0].kind, "note");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy JSONL migrates once, preserves attempts, and imports later appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-migrate-"));
  try {
    const project = join(root, "project");
    const home = join(root, "home");
    const store = new KnowledgeStore(project, home);
    const projectLog = join(project, ".orch", "knowledge.jsonl");
    const globalLog = join(home, "knowledge.jsonl");
    await Promise.all([mkdir(join(project, ".orch"), { recursive: true }), mkdir(home, { recursive: true })]);
    const note = { kind: "note", at: "2024-01-02T03:04:05.000Z", text: "Keep this note" };
    const attempt = { kind: "attempt", at: "2024-02-03T04:05:06.000Z", taskId: "T1", taskType: "test", difficulty: "hard", risk: "high", route: "sol-high", model: "codex:sol", passed: false, errors: ["check failed"], inputTokens: 12, outputTokens: 3, checkCommand: "npm test", simulated: false };
    const legacy = `${JSON.stringify(note)}\n${JSON.stringify(attempt)}\n`;
    await writeFile(projectLog, legacy);
    await writeFile(globalLog, `${JSON.stringify(note)}\n`);

    const first = await store.list("project");
    assert.equal(first.length, 2);
    assert.equal(first[0].kind, "note");
    if (first[0].kind === "note") {
      assert.equal(first[0].createdAt, note.at);
      assert.equal(first[0].updatedAt, note.at);
      assert.equal(first[0].text, note.text);
      assert.equal(first[0].reviewStatus, "pending");
    }
    assert.equal(first[1].kind, "attempt");
    if (first[1].kind === "attempt") {
      assert.equal(first[1].at, attempt.at);
      assert.deepEqual(first[1].errors, attempt.errors);
      assert.equal(first[1].checkCommand, attempt.checkCommand);
      assert.equal(first[1].inputTokens, attempt.inputTokens);
      assert.equal(first[1].simulated, false);
    }
    assert.equal(await readFile(projectLog, "utf8"), legacy);
    const global = await store.list("global");
    assert.equal(global.length, 1);
    assert.equal(global[0].sourceProject, null); // Legacy global records did not identify their source.
    assert.deepEqual((await store.list("project")).map((entry) => entry.id), first.map((entry) => entry.id));

    await appendFile(projectLog, `${JSON.stringify({ ...attempt, at: "2024-03-04T05:06:07.000Z", simulated: true })}\n`);
    const next = await store.list("project");
    assert.equal(next.length, 3);
    assert.deepEqual(next.slice(0, 2).map((entry) => entry.id), first.map((entry) => entry.id));
    assert.equal(next[2].kind === "attempt" && next[2].simulated, true);
    await store.note("project", "New note", "refactor");
    const snapshot = JSON.parse(await readFile(store.path("project"), "utf8"));
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.entries.length, 4);
    assert.equal(snapshot.entries[3].taskCategory, "refactor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed legacy data and unsupported schema fail without replacing history", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-migrate-error-"));
  try {
    const store = new KnowledgeStore(join(root, "project"), join(root, "home"));
    const legacy = join(root, "project", ".orch", "knowledge.jsonl");
    await mkdir(join(root, "project", ".orch"), { recursive: true });
    await writeFile(legacy, '{"kind":"note","at":"2024-01-01T00:00:00Z","text":"safe"}\n{broken');
    await assert.rejects(store.list("project"), /Invalid knowledge entry at line 2/);
    await assert.rejects(readFile(store.path("project"), "utf8"), /ENOENT/);
    await writeFile(legacy, '{"kind":"note","at":"2024-01-01T00:00:00Z","text":"safe"}\n');
    assert.equal((await store.list("project")).length, 1);
    const before = await readFile(store.path("project"), "utf8");
    await writeFile(store.path("project"), before.replace('"schemaVersion": 1', '"schemaVersion": 2'));
    await assert.rejects(store.list("project"), /Unsupported knowledge schema version: 2/);
    assert.equal(await readFile(legacy, "utf8"), '{"kind":"note","at":"2024-01-01T00:00:00Z","text":"safe"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent local writers retain every note", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-knowledge-writers-"));
  try {
    const first = new KnowledgeStore(join(root, "project"), join(root, "home"));
    const second = new KnowledgeStore(join(root, "project"), join(root, "home"));
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? first : second).note("project", `note ${index}`)));
    const entries = await first.list("project");
    assert.equal(entries.length, 12);
    assert.equal(new Set(entries.map((entry) => entry.id)).size, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed promotion, edits, removal, and export retain private-safe audit evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-review-"));
  try {
    const store = new KnowledgeStore(join(root, "project"), join(root, "home"));
    await assert.rejects(store.note("global", "Reusable advice"), /review/);
    const note = await store.note("project", "Run C:/private/repo/check.ps1 for this task", "test");
    await assert.rejects(store.promote(note.id), /Review/);
    await store.review(note.id, "approved");
    await assert.rejects(store.promote(note.id), /generalized/);
    await store.edit(note.id, "For tests, verify behavior at the public boundary");
    assert.equal((await store.list("project")).find((entry) => entry.id === note.id)?.kind, "note");
    await assert.rejects(store.promote(note.id), /Review/);
    await store.review(note.id, "approved");
    const global = await store.promote(note.id);
    assert.equal(global.sourceEntryId, note.id);
    assert.equal(global.sourceProject, note.sourceProject);
    assert.equal(global.taskCategory, "test");
    await assert.rejects(store.append("global", { ...global, id: "fabricated", sourceEntryId: "missing" }), /approved project note/);
    await assert.rejects(store.append("global", { ...global, id: "extra", privatePath: "C:/repo" } as never), /allowlist/);
    await assert.rejects(store.promote(note.id), /already promoted/);
    await store.remove("global", global.id);
    const exported = await store.export("global");
    assert.deepEqual(exported.entries, []);
    assert.deepEqual(exported.audit.map((item) => item.action), ["promote", "remove"]);
    assert.doesNotMatch(JSON.stringify(exported), /private\/repo|check\.ps1/);
    const localAudit = await store.audit("project");
    assert.deepEqual(localAudit.map((item) => item.action), ["add", "review", "edit", "review", "promote"]);
    assert.ok(localAudit.every((item) => item.textDigest));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live validated observations deduplicate with linked evidence and require review", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-candidates-"));
  try {
    const first = new KnowledgeStore(join(root, "project"), join(root, "home"));
    const second = new KnowledgeStore(join(root, "project"), join(root, "home"));
    const task: TaskSpec = { id: "TASK-001", description: "Rename a type", type: "rename", difficulty: "easy", risk: "low", dependsOn: [] };
    const attempt = { attempt: 1, route: routeTask(task), validation: { passed: true, errors: [] }, model: "codex:gpt-6-luna" };
    await first.recordAttempt("project", task, attempt, true, "simulated-run");
    await first.recordAttempt("project", task, { ...attempt, validation: { passed: false, errors: ["check failed"] } }, false, "failed-run");
    await Promise.all([
      first.recordAttempt("project", task, attempt, false, "live-run-1"),
      second.recordAttempt("project", task, attempt, false, "live-run-2"),
    ]);
    let entries = await first.list("project");
    let candidates = entries.filter((entry) => entry.kind === "candidate");
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    assert.equal(candidate.reviewStatus, "pending");
    assert.deepEqual(new Set(candidate.evidence.map((item) => item.runId)), new Set(["live-run-1", "live-run-2"]));
    assert.ok(candidate.evidence.every((item) => entries.some((entry) => entry.kind === "attempt" && entry.id === item.attemptId && !entry.simulated && entry.passed)));
    assert.equal(entries.filter((entry) => entry.kind === "note").length, 0);
    await first.edit(candidate.id, "For similar renames, consider the observed validated route");
    const approved = await first.review(candidate.id, "approved");
    assert.equal(approved.kind, "candidate");
    if (approved.kind !== "candidate") return;
    assert.ok(approved.lessonId);
    await second.recordAttempt("project", task, attempt, false, "live-run-3");
    await first.recordAttempt("project", task, attempt, false, "live-run-3");
    entries = await first.list("project");
    candidates = entries.filter((entry) => entry.kind === "candidate");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].evidence.length, 3);
    const notes = entries.filter((entry) => entry.kind === "note");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, approved.lessonId);
    assert.equal(notes[0].reviewStatus, "approved");
    assert.equal(notes[0].text, "For similar renames, consider the observed validated route");
    await first.review(candidate.id, "approved");
    assert.equal((await first.list("project")).filter((entry) => entry.kind === "note").length, 1);
    await assert.rejects(first.review(candidate.id, "rejected"), /already has a lesson/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model selection honors weights and never enables an unconnected Claude provider", () => {
  const registry = defaultRegistry();
  registry.models.push({ alias: "luna-new", provider: "codex", model: "a-new-model", tier: "luna-low", effort: "low", enabled: true, weight: 3 });
  assert.equal(selectModel(registry, { worker: "luna", effort: "low", label: "luna-low" }).alias, "luna-new");
  const claude = registry.models.find((model) => model.provider === "claude")!;
  claude.enabled = true;
  assert.throws(() => validateProfile(claude), /Claude execution is unavailable/);
});

test("extreme tasks route to Sol with extra-high effort", () => {
  const task: TaskSpec = { id: "T1", description: "Large migration", type: "refactor", difficulty: "extreme", risk: "critical", dependsOn: [] };
  assert.equal(routeTask(task).label, "sol-xhigh");
});
