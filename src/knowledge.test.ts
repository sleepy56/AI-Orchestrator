import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    await store.note("global", "Prefer low effort for simple renames");
    const task: TaskSpec = { id: "TASK-001", description: "Rename a type", type: "rename", difficulty: "easy", risk: "low", dependsOn: [] };
    await store.recordAttempt("project", task, { attempt: 1, route: routeTask(task), validation: { passed: true, errors: [] }, model: "codex:gpt-6-luna", inputTokens: 10, outputTokens: 5 }, false);
    await store.recordAttempt("global", task, { attempt: 2, route: routeTask(task), validation: { passed: false, errors: ["private path" ] }, checkCommand: "private check", model: "codex:gpt-6-luna" }, false);
    const project = await store.list("project");
    const global = await store.list("global");
    assert.equal(project.length, 2);
    assert.equal(global.length, 2);
    assert.equal(project[1].kind, "attempt");
    if (project[1].kind === "attempt") {
      assert.equal(project[1].model, "codex:gpt-6-luna");
      assert.equal(project[1].inputTokens, 10);
      assert.equal(project[1].simulated, false);
    }
    if (global[1].kind === "attempt") {
      assert.deepEqual(global[1].errors, []);
      assert.equal(global[1].checkCommand, undefined);
    }
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
