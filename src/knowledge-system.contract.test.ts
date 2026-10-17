import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { KnowledgeStore } from "./knowledge";
import { defaultRegistry, loadRegistry, selectModel, validateProfile } from "./models";
import { routeTask } from "./router";
import { readRunEvents, RunEventWriter } from "./run-events";
import { TaskSpec } from "./types";

const task: TaskSpec = {
  id: "TASK-001", description: "Rename a shared type", type: "rename",
  difficulty: "easy", risk: "low", dependsOn: [],
};

async function fixture(run: (project: string, home: string) => Promise<void>): Promise<void> {
  const workspace = resolve(process.cwd());
  const root = await mkdtemp(join(workspace, ".orch-contract-"));
  try {
    await run(join(root, "project"), join(root, "home"));
  } finally {
    if (!resolve(root).startsWith(workspace + sep)) throw new Error("Refusing to remove a fixture outside the workspace");
    await rm(root, { recursive: true, force: true });
  }
}

function cli(project: string, home: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(__dirname, "cli.js"), ...args], {
    cwd: project, encoding: "utf8", env: { ...process.env, ORCH_HOME: home },
  });
}

test("legacy JSONL notes and attempts gain metadata without losing original evidence", async () => fixture(async (project, home) => {
  await mkdir(join(project, ".orch"), { recursive: true });
  const legacy = [
    { kind: "note", at: "2025-01-02T00:00:00.000Z", text: "Use the project test suite" },
    { kind: "attempt", at: "2025-01-03T00:00:00.000Z", taskId: "TASK-001", taskType: "rename",
      difficulty: "easy", risk: "low", route: "luna-low", model: "codex:gpt-6-luna",
      passed: true, errors: [], inputTokens: 10, outputTokens: 5, simulated: false },
  ];
  await writeFile(join(project, ".orch", "knowledge.jsonl"), legacy.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const entries = await new KnowledgeStore(project, home).list("project") as unknown as Array<Record<string, unknown>>;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, legacy[0].text);
  assert.equal(entries[1].inputTokens, 10);
  assert.equal(entries[1].simulated, false);
  for (const entry of entries) {
    assert.match(String(entry.id), /\S/);
    assert.equal(entry.scope, "project");
    assert.match(String(entry.sourceProject), /\S/);
  }
  assert.equal(entries[0].createdAt, legacy[0].at);
  assert.equal(entries[0].reviewStatus, "pending");
  assert.equal(entries[1].at, legacy[1].at);
  assert.equal(entries[1].taskType, "rename");
}));

test("global reuse requires review and refuses project-specific text", async () => fixture(async (project, home) => {
  await mkdir(project, { recursive: true });
  assert.equal(cli(project, home, "init").status, 0);
  const store = new KnowledgeStore(project, home);
  await store.note("project", "For renames, validate public references before changing a type");
  const local = await store.list("project") as unknown as Array<Record<string, unknown>>;
  const id = String(local[0].id);
  assert.match(id, /\S/);
  assert.equal((await store.list("global")).length, 0);
  assert.equal(cli(project, home, "knowledge", "review", id, "--status", "approved").status, 0);
  assert.equal(cli(project, home, "knowledge", "promote", id).status, 0);
  const global = await store.list("global") as unknown as Array<Record<string, unknown>>;
  assert.equal(global.length, 1);
  assert.equal(global[0].reviewStatus, "approved");
  assert.equal(global[0].scope, "global");

  await store.note("project", "Run G:/private-repo/secrets/check.ps1 before merging");
  const privateId = String((await store.list("project") as unknown as Array<Record<string, unknown>>).at(-1)?.id);
  assert.equal(cli(project, home, "knowledge", "review", privateId, "--status", "approved").status, 0);
  assert.notEqual(cli(project, home, "knowledge", "promote", privateId).status, 0);
  assert.equal((await store.list("global")).length, 1);
}));

test("live outcomes create one reviewable candidate; simulated outcomes create none", async () => fixture(async (project, home) => {
  const store = new KnowledgeStore(project, home);
  const attempt = { attempt: 1, route: routeTask(task), validation: { passed: true, errors: [] },
    model: "codex:gpt-6-luna", inputTokens: 10, outputTokens: 5, latencyMs: 1000 };
  await store.recordAttempt("project", task, attempt, true, "simulated-run");
  let candidates = (await store.list("project") as unknown as Array<Record<string, unknown>>).filter((entry) => entry.kind === "candidate");
  assert.equal(candidates.length, 0);
  await store.recordAttempt("project", task, attempt, false, "live-run-1");
  await store.recordAttempt("project", task, attempt, false, "live-run-2");
  candidates = (await store.list("project") as unknown as Array<Record<string, unknown>>).filter((entry) => entry.kind === "candidate");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reviewStatus, "pending");
  assert.equal(candidates[0].taskCategory, "rename");
  assert.match(JSON.stringify(candidates[0]), /live-run-1/);
  assert.match(JSON.stringify(candidates[0]), /live-run-2/);
  assert.doesNotMatch(JSON.stringify(candidates[0]), /simulated-run/);
}));

test("retrieval is bounded, relevant, reviewed, and explains every selected lesson", async () => fixture(async (project, home) => {
  const store = new KnowledgeStore(project, home);
  const source = new KnowledgeStore(join(dirname(project), "source-project"), home);
  const promote = async (text: string, category: "rename" | "analysis") => {
    const note = await source.note("project", text, category);
    await source.review(note.id, "approved");
    return (await source.promote(note.id)).id;
  };
  const base = { kind: "note", sourceProject: "fixture-project-a", sourceRunId: null,
    source: "reviewed-user-note", taskCategory: "rename",
    createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", reviewStatus: "approved" };
  await store.append("project", { ...base, id: "project-rename", scope: "project", at: base.createdAt,
    text: "For renames, update public references" } as never);
  const globalRenameId = await promote("For renames, search all call sites", "rename");
  await store.append("project", { ...base, id: "pending-rename", scope: "project", reviewStatus: "pending",
    at: base.createdAt, text: "Unreviewed rename advice" } as never);
  await promote("Analyze database indexes", "analysis");
  const retrieve = (store as unknown as { retrieve: (item: TaskSpec, limit: number) => Promise<Array<{ entry: { id: string }; reason: string }>> }).retrieve;
  assert.equal(typeof retrieve, "function");
  const selected = await retrieve.call(store, task, 2);
  assert.deepEqual(new Set(selected.map((item) => item.entry.id)), new Set(["project-rename", globalRenameId]));
  assert.ok(selected.every((item) => item.reason.trim().length > 0));
  assert.ok(selected.length <= 2);
  const otherProject = new KnowledgeStore(join(dirname(project), "other-project"), home);
  const acrossProjects = await retrieve.call(otherProject, task, 2);
  assert.deepEqual(acrossProjects.map((item) => item.entry.id), [globalRenameId]);
}));

test("retrieval ranks matching risk and task text within a category", async () => fixture(async (project, home) => {
  const store = new KnowledgeStore(project, home);
  const add = async (id: string, text: string) => store.append("project", {
    kind: "note", id, scope: "project", sourceProject: "fixture-project", sourceRunId: null,
    text, taskCategory: "refactor", reviewStatus: "approved",
    createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
  });
  await add("generic", "Refactor carefully");
  await add("wrong-risk", "For high risk refactors, keep changes small");
  await add("matching-risk", "For medium risk refactors, keep changes small");
  await add("matching-text", "For medium risk refactors, verify cache invalidation boundaries");
  const selected = await store.retrieve({ id: "T", description: "Refactor cache invalidation", type: "refactor",
    difficulty: "hard", risk: "medium", dependsOn: [] }, 2);
  assert.deepEqual(selected.map(({ entry }) => entry.id), ["matching-text", "matching-risk"]);
  assert.match(selected[0].reason, /category refactor.*task text.*medium risk/);
  assert.equal((await store.retrieve({ id: "T", description: "Refactor cache invalidation", type: "refactor",
    difficulty: "hard", risk: "medium", dependsOn: [] }, 20)).length, 3);
}));

test("a live run sends only selected lessons and records their IDs", async () => fixture(async (project, home) => {
  await mkdir(project, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  await writeFile(join(project, ".gitignore"), ".orch/\n");
  git("add", ".gitignore");
  git("-c", "user.name=Orch Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base");
  const baseCommit = git("rev-parse", "HEAD");
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", task.description, "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
  assert.equal(cli(project, home, "plan", "Analyze database indexes", "--type", "analysis", "--difficulty", "easy", "--risk", "low").status, 0);
  assert.equal(cli(project, home, "worktrees", "base", "main", baseCommit).status, 0);
  const store = new KnowledgeStore(project, home);
  const source = new KnowledgeStore(join(dirname(project), "source-project"), home);
  const promote = async (text: string, category: "rename" | "analysis") => {
    const note = await source.note("project", text, category);
    await source.review(note.id, "approved");
    return (await source.promote(note.id)).id;
  };
  const base = { kind: "note", taskCategory: "rename", sourceProject: "fixture-project-a", sourceRunId: null,
    createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" };
  await store.append("project", { ...base, id: "used-project", scope: "project", reviewStatus: "approved",
    text: "Rename lesson: check public references" } as never);
  const globalLessonId = await promote("Rename lesson: search call sites", "rename");
  await store.append("project", { ...base, id: "pending", scope: "project", reviewStatus: "pending",
    text: "Unreviewed secret advice" } as never);
  for (let index = 0; index < 12; index += 1) {
    await promote(`Analyze database index ${index}`, "analysis");
  }

  const bin = join(dirname(project), "fake-bin");
  const entry = join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
  const capture = join(dirname(project), "captured-prompt.json");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.ORCH_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));",
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));",
  ].join("\n"));
  await writeFile(join(bin, "codex.cmd"), "rem fake Codex launcher\n");
  const unixLauncher = join(bin, "codex");
  await writeFile(unixLauncher, `#!/bin/sh\n"${process.execPath}" "${entry}" "$@"\n`);
  await chmod(unixLauncher, 0o755);
  const run = spawnSync(process.execPath, [join(__dirname, "cli.js"), "run", "--executor", "codex",
    "--check", "echo fixture check", "--timeout-seconds", "10"], {
    cwd: project, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, ORCH_HOME: home, ORCH_CAPTURE: capture,
      PATH: [bin, dirname(process.execPath), ...(process.platform === "win32" ? ["C:\\Program Files\\Git\\cmd", "C:\\Windows\\system32"] : ["/usr/bin", "/bin"])].join(delimiter) },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const prompts = (await readFile(capture, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as string[]).at(-1) ?? "");
  assert.equal(prompts.length, 2);
  const [prompt, analysisPrompt] = prompts;
  assert.match(prompt, /Rename lesson: check public references/);
  assert.match(prompt, /Rename lesson: search call sites/);
  assert.doesNotMatch(prompt, /Unreviewed secret advice|Analyze database index/);
  assert.match(analysisPrompt, /Analyze database index/);
  assert.doesNotMatch(analysisPrompt, /Rename lesson|Unreviewed secret advice/);
  const events = await readRunEvents(project);
  const selected = events.filter((event) => (event as { type: string }).type === "knowledge.selected") as unknown as Array<{ lessonIds: string[]; selections: Array<{ id: string; reason: string }> }>;
  assert.equal(selected.length, 2);
  assert.deepEqual(new Set(selected[0].lessonIds), new Set(["used-project", globalLessonId]));
  assert.ok(selected[0].lessonIds.length <= 5);
  assert.equal(selected[1].lessonIds.length, 5);
  assert.ok(selected.every((event) => event.selections.every((item) => event.lessonIds.includes(item.id) && item.reason.length > 0)));
}));

test("Luna low, medium, and high remain distinct and old model settings survive loading", async () => fixture(async (project) => {
  const defaults = defaultRegistry();
  for (const effort of ["low", "medium", "high"] as const) {
    const route = { worker: "luna" as const, effort, label: `luna-${effort}` as const };
    const profile = selectModel(defaults, route);
    assert.equal(profile.model, "gpt-6-luna");
    assert.equal(profile.effort, effort);
  }
  assert.throws(() => validateProfile({ alias: "mismatch", provider: "codex", model: "gpt-6-luna",
    tier: "luna-medium", effort: "high", enabled: true, weight: 1 }), /effort|tier/i);
  await mkdir(join(project, ".orch"), { recursive: true });
  await writeFile(join(project, ".orch", "models.json"), JSON.stringify({ version: 1, policyVersion: 9, models: [
    { alias: "my-luna", provider: "codex", model: "gpt-6-luna", tier: "luna-low",
      effort: "low", enabled: true, weight: 7 },
    { alias: "manual-high", provider: "codex", model: "custom-high", tier: "luna-high",
      effort: "high", enabled: false, weight: 8 },
  ] }));
  const migrated = await loadRegistry(project);
  assert.equal(migrated.policyVersion, 9);
  assert.equal(migrated.models.find((model) => model.alias === "my-luna")?.weight, 7);
  assert.equal(migrated.models.find((model) => model.tier === "luna-medium")?.model, "gpt-6-luna");
  assert.deepEqual(migrated.models.filter((model) => model.tier === "luna-high").map((model) =>
    [model.alias, model.model, model.enabled, model.weight]), [["manual-high", "custom-high", false, 8]]);
  assert.equal((await loadRegistry(project)).models.length, migrated.models.length);
}));

test("route proposals do not treat simulations as evidence or override a manual choice", () => {
  const decisions = require("./model-decisions") as Record<string, unknown>;
  assert.equal(typeof decisions.recommendModelRoute, "function");
  const recommend = decisions.recommendModelRoute as (input: unknown) => Record<string, unknown>;
  const registry = defaultRegistry();
  const simulated = { taskType: "rename", difficulty: "easy", risk: "low", route: "luna-low",
    model: "codex:gpt-6-luna", passed: true, simulated: true, inputTokens: 100, outputTokens: 20, latencyMs: 1000 };
  const withoutLiveEvidence = recommend({ task, registry, attempts: Array(20).fill(simulated), prices: {}, manualAlias: undefined });
  assert.equal(withoutLiveEvidence.recommendedAlias, undefined);
  assert.match(String(withoutLiveEvidence.reason), /evidence|sample|unknown/i);
  const manual = recommend({ task, registry, attempts: [], prices: {}, manualAlias: "luna-low" });
  assert.equal(manual.chosenAlias, "luna-low");
  assert.match(String(manual.fallbackAlias), /\S/);
});

test("cheaper route proposals require comparable live results and known prices", () => {
  const { recommendModelRoute } = require("./model-decisions") as {
    recommendModelRoute: (input: unknown) => Record<string, unknown>;
  };
  const registry = defaultRegistry();
  const comparable = { taskType: "analysis", difficulty: "moderate", risk: "medium",
    passed: true, simulated: false, inputTokens: 1000, outputTokens: 100, latencyMs: 2000 };
  const attempts = [
    ...Array.from({ length: 8 }, (_, index) => ({ ...comparable, taskId: `SOL-${index}`, route: "sol-medium",
      model: "codex:gpt-6-sol", attempt: 1 })),
    ...Array.from({ length: 8 }, (_, index) => ({ ...comparable, taskId: `LUNA-${index}`, route: "luna-medium",
      model: "codex:gpt-6-luna", attempt: 1, inputTokens: 800, latencyMs: 1500 })),
  ];
  const input = { task: { ...task, type: "analysis", difficulty: "moderate", risk: "medium" },
    registry, attempts, manualAlias: undefined };
  const noPrices = recommendModelRoute({ ...input, prices: {} });
  assert.equal(noPrices.recommendedAlias, undefined);
  const knownPrices = recommendModelRoute({ ...input, prices: {
    version: "fixture-1", currency: "USD", models: {
      "codex:gpt-6-sol": { inputPerMillion: 10, outputPerMillion: 20 },
      "codex:gpt-6-luna": { inputPerMillion: 1, outputPerMillion: 2 },
    },
  } });
  assert.equal(knownPrices.recommendedAlias, "luna-medium");
  assert.equal(knownPrices.fallbackAlias, "sol-medium");
  assert.match(String(knownPrices.reason), /observed|comparable|validated/i);
  assert.doesNotMatch(String(knownPrices.reason), /would have succeeded/i);
});

test("route proposals count distinct comparable tasks and include retry-adjusted evidence and uncertainty", () => {
  const { recommendModelRoute } = require("./model-decisions") as typeof import("./model-decisions");
  const selectedTask: TaskSpec = { ...task, type: "analysis", difficulty: "moderate", risk: "medium" };
  const prices = { version: "reviewed-2026-10", currency: "USD", models: {
    "codex:gpt-6-sol": { inputPerMillion: 10, outputPerMillion: 20 },
    "codex:gpt-6-luna": { inputPerMillion: 1, outputPerMillion: 2 },
  } };
  const row = (taskId: string, route: "sol-medium" | "luna-medium", attemptNumber: number, passed: boolean) => ({
    id: `${taskId}-${attemptNumber}`, taskId, sourceRunId: "run-1", attemptNumber,
    taskType: "analysis" as const, difficulty: "moderate" as const, risk: "medium" as const,
    route, model: route === "sol-medium" ? "codex:gpt-6-sol" : "codex:gpt-6-luna",
    passed, simulated: false, inputTokens: 1000, outputTokens: 100, latencyMs: 1000,
  });
  const sol = Array.from({ length: 8 }, (_, index) => row(`SOL-${index}`, "sol-medium", 1, true));
  const luna = Array.from({ length: 8 }, (_, index) => row(`LUNA-${index}`, "luna-medium", 1, true));
  const input = { task: selectedTask, registry: defaultRegistry(), prices, attempts: [...sol, ...luna] };
  const proposal = recommendModelRoute(input);
  assert.equal(proposal.recommendedAlias, "luna-medium");
  assert.equal(proposal.chosenAlias, "sol-medium");
  assert.equal(proposal.priceVersion, prices.version);
  assert.equal(proposal.candidate?.taskCount, 8);
  assert.equal(proposal.candidate?.validatedPasses, 8);
  assert.equal(proposal.candidate?.retries, 0);
  assert.ok((proposal.candidate?.passRate95[0] ?? 1) < 1);
  assert.match(proposal.uncertainty, /do not establish/i);

  const withRetry = recommendModelRoute({ ...input, attempts: [...sol, ...luna.slice(1),
    { ...luna[0], id: "LUNA-0-failed", passed: false }, { ...luna[0], attemptNumber: 2, id: "LUNA-0-passed" }] });
  assert.equal(withRetry.candidate?.taskCount, 8);
  assert.equal(withRetry.candidate?.attemptCount, 9);
  assert.equal(withRetry.candidate?.retries, 1);
  assert.ok((withRetry.candidate?.averageCostPerTask ?? 0) > (proposal.candidate?.averageCostPerTask ?? 0));
  assert.ok((withRetry.candidate?.averageLatencyMs ?? 0) > (proposal.candidate?.averageLatencyMs ?? 0));
  assert.equal(recommendModelRoute({ ...input, attempts: [...sol, ...luna.slice(1),
    ...Array.from({ length: 3 }, (_, index) => ({ ...luna[0], id: `retry-${index}`, attemptNumber: index + 1, passed: false })),
    { ...luna[0], id: "final-pass", attemptNumber: 4 }] }).recommendedAlias, undefined);
  assert.equal(recommendModelRoute({ ...input, attempts: [...sol, ...luna.map((entry) => ({ ...entry, latencyMs: 1500 }))] }).recommendedAlias, undefined);
  assert.equal(recommendModelRoute({ ...input, attempts: [...sol, ...luna.slice(0, 7), ...Array(100).fill(luna[0])] }).recommendedAlias, undefined);
  assert.equal(recommendModelRoute({ ...input, attempts: [...sol, ...luna.map((entry) => ({ ...entry, risk: "low" as const }))] }).recommendedAlias, undefined);
  assert.equal(recommendModelRoute({ ...input, attempts: [...sol, ...luna.map((entry) => ({ ...entry, simulated: true }))] }).recommendedAlias, undefined);
  assert.equal(recommendModelRoute({ ...input, attempts: [...sol, ...luna.map((entry, index) => index === 0 ? { ...entry, inputTokens: undefined } : entry)] }).recommendedAlias, undefined);
  assert.equal(recommendModelRoute({ ...input, prices: { ...prices, version: "" } }).recommendedAlias, undefined);
  const manual = recommendModelRoute({ ...input, manualAlias: "luna-high" });
  assert.equal(manual.chosenAlias, "luna-high");
  assert.equal(manual.recommendedAlias, undefined);
  assert.equal(manual.fallbackAlias, "sol-medium");
});

test("route proposals do not credit fallback successes to a failed cheaper route", () => {
  const { recommendModelRoute } = require("./model-decisions") as typeof import("./model-decisions");
  const selectedTask: TaskSpec = { ...task, type: "analysis", difficulty: "moderate", risk: "medium" };
  const attempts = [
    ...Array.from({ length: 8 }, (_, index) => ({ taskId: `S${index}`, taskType: "analysis" as const,
      difficulty: "moderate" as const, risk: "medium" as const, route: "sol-medium", model: "codex:gpt-6-sol",
      passed: true, simulated: false, inputTokens: 1000, outputTokens: 100, latencyMs: 1000 })),
    ...Array.from({ length: 8 }, (_, index) => ({ taskId: `L${index}`, taskType: "analysis" as const,
      difficulty: "moderate" as const, risk: "medium" as const, route: "luna-medium", model: "codex:gpt-6-luna",
      passed: false, simulated: false, inputTokens: 500, outputTokens: 50, latencyMs: 500 })),
  ];
  const result = recommendModelRoute({ task: selectedTask, registry: defaultRegistry(), attempts, prices: {
    version: "fixture-2", currency: "USD", models: {
      "codex:gpt-6-sol": { inputPerMillion: 10, outputPerMillion: 20 },
      "codex:gpt-6-luna": { inputPerMillion: 1, outputPerMillion: 2 },
    },
  } });
  assert.equal(result.recommendedAlias, undefined);
  assert.equal(result.chosenAlias, "sol-medium");
});

test("route proposals are visible through a CLI command without changing model settings", async () => fixture(async (project, home) => {
  await mkdir(project, { recursive: true });
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "Inspect routes", "--type", "analysis", "--difficulty", "moderate", "--risk", "medium").status, 0);
  const priceFile = join(project, "prices.json");
  await writeFile(priceFile, JSON.stringify({ version: "fixture-3", currency: "USD", models: {} }));
  const result = cli(project, home, "models", "recommend", "TASK-001", "--prices", priceFile, "--manual-alias", "luna-medium");
  assert.equal(result.status, 0, result.stderr);
  const proposal = JSON.parse(result.stdout) as { chosenAlias: string; fallbackAlias: string; recommendedAlias?: string; uncertainty: string };
  assert.equal(proposal.chosenAlias, "luna-medium");
  assert.equal(proposal.fallbackAlias, "sol-medium");
  assert.equal(proposal.recommendedAlias, undefined);
  assert.match(proposal.uncertainty, /95%/);
  assert.equal((await readFile(join(project, ".orch", "models.json"), "utf8")).includes("manualAlias"), false);
}));

test("local API distinguishes selected knowledge from observations", async () => fixture(async (project, home) => {
  await mkdir(project, { recursive: true });
  assert.equal(cli(project, home, "init").status, 0);
  assert.equal(cli(project, home, "plan", "Rename public references", "--type", "rename", "--difficulty", "easy", "--risk", "low").status, 0);
  const store = new KnowledgeStore(project, home);
  const note = await store.note("project", "For renames, inspect public references");
  await store.review(note.id, "approved");
  const observed = { attempt: 1, route: routeTask(task), validation: { passed: true, errors: [] },
    model: "codex:gpt-6-luna", inputTokens: 10, outputTokens: 5, latencyMs: 1000 };
  await store.recordAttempt("project", task, observed, true, "simulated-run");
  await store.recordAttempt("project", task, observed, false, "live-run");
  const writer = new RunEventWriter(project);
  await writer.append({ type: "run.started", mode: "live", tasks: [], policyVersion: 1 });
  await writer.append({ type: "knowledge.selected", taskId: "TASK-001", lessonIds: ["historical-lesson"],
    selections: [{ id: "historical-lesson", scope: "project", reason: "past task context" }] });
  await writeFile(join(project, ".orch", "prices.json"), JSON.stringify({ version: "reviewed-fixture", currency: "USD", models: {} }));
  const previousHome = process.env.ORCH_HOME;
  process.env.ORCH_HOME = home;
  const { createLocalApi } = require("./local-api") as typeof import("./local-api");
  const server = createLocalApi(project);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/knowledge`, { headers: { Host: `127.0.0.1:${address.port}` } });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(Array.isArray(body.lessons));
    assert.ok(Array.isArray(body.candidates));
    assert.equal((body.candidates as Array<{ evidence: Array<{ runId: string }> }>).length, 1);
    assert.deepEqual((body.candidates as Array<{ evidence: Array<{ runId: string }> }>)[0].evidence.map((item) => item.runId), ["live-run"]);
    assert.ok(Array.isArray(body.usedInRuns));
    assert.equal((body.lessons as Array<{ id: string }>)[0].id, note.id);
    assert.equal((body.retrieval as Array<{ selections: Array<{ id: string; reason: string }> }>)[0].selections[0].id, note.id);
    assert.match((body.retrieval as Array<{ selections: Array<{ reason: string }> }>)[0].selections[0].reason, /category|task text/);
    assert.deepEqual((body.usedInRuns as Array<{ lessonIds: string[] }>)[0].lessonIds, ["historical-lesson"]);
    const proposalsResponse = await fetch(`http://127.0.0.1:${address.port}/api/model-proposals`);
    assert.equal(proposalsResponse.status, 200);
    const proposals = await proposalsResponse.json() as { priceVersion: string; proposals: Array<{ proposal: { recommendedAlias?: string; fallbackAlias: string } }> };
    assert.equal(proposals.priceVersion, "reviewed-fixture");
    assert.equal(proposals.proposals[0].proposal.fallbackAlias, "luna-low");
    assert.equal(proposals.proposals[0].proposal.recommendedAlias, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.ORCH_HOME;
    else process.env.ORCH_HOME = previousHome;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));
