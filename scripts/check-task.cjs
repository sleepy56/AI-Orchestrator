#!/usr/bin/env node
// Task-specific acceptance gate for `orch run --check "node scripts/check-task.cjs TASK-011"`.
// This command never calls `orch run` or changes task status.
const { existsSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
const task = process.argv[2];
const backend = [
  "dist/orchestrator.test.js", "dist/cli.test.js", "dist/knowledge.test.js",
  "dist/providers.test.js", "dist/local-api.test.js",
];
const knowledgeContract = "dist/knowledge-system.contract.test.js";
const workflowContract = "dist/orch-workflow.contract.test.js";
const uiContract = "ui/test/orch-workflow.contract.test.cjs";
const uiTests = ["ui/test/evidence.test.cjs", "ui/test/replay.test.cjs"];

const gates = {
  "TASK-011": { file: knowledgeContract, pattern: "retrieval|a live run sends" },
  "TASK-012": { file: knowledgeContract, pattern: "Luna low" , ui: true },
  "TASK-013": { file: knowledgeContract, pattern: "route proposals|cheaper route" },
  "TASK-014": { file: knowledgeContract, pattern: "local API distinguishes", ui: true, uiContract: true },
  "TASK-015": { file: workflowContract, pattern: "\\[TASK-015\\]", extraFile: knowledgeContract, ui: true, uiContract: true },
  "TASK-016": { file: workflowContract, pattern: "\\[TASK-016\\]" },
  "TASK-017": { file: workflowContract, pattern: "\\[TASK-017\\]", ui: true, uiContract: true },
  "TASK-018": { file: workflowContract, pattern: "\\[TASK-018\\]", ui: true, uiContract: true },
  "TASK-019": { file: workflowContract, pattern: "\\[TASK-019\\]", ui: true, uiContract: true },
  "TASK-020": { file: workflowContract, pattern: "\\[TASK-020\\]", ui: true, uiContract: true },
  "TASK-021": { file: workflowContract, pattern: "\\[TASK-021\\]" },
  "TASK-022": { file: workflowContract, pattern: "\\[TASK-022\\]" },
  "TASK-023": { file: workflowContract, pattern: "\\[TASK-023\\]" },
  "TASK-024": { file: workflowContract, pattern: "\\[TASK-024\\]" },
  "TASK-025": { file: workflowContract, pattern: "\\[TASK-025\\]", ui: true, uiContract: true },
  "TASK-026": { file: workflowContract, pattern: "\\[TASK-026\\]" },
  "TASK-027": { file: workflowContract, pattern: "\\[TASK-027\\]", ui: true, uiContract: true },
};

if (task === "--list") {
  for (const [id, gate] of Object.entries(gates)) {
    console.log(`${id}: ${gate.file} / ${gate.pattern}${gate.ui ? " + UI" : ""}`);
  }
  process.exit(0);
}
if (!Object.hasOwn(gates, task)) {
  console.error(`Unknown task ${task ?? "(missing)"}. Use --list to see supported task IDs.`);
  process.exit(2);
}

function run(label, args) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

const gate = gates[task];
const taskStore = join(root, ".orch", "tasks.json");
if (existsSync(taskStore)) {
  const snapshot = JSON.parse(readFileSync(taskStore, "utf8"));
  const running = snapshot.tasks.filter((record) => record.status === "running").map((record) => record.spec.id);
  if (running.length && !running.includes(task)) {
    console.error(`${task} check does not match the running task: ${running.join(", ")}.`);
    process.exit(2);
  }
}
run("Compile backend", ["node_modules/typescript/bin/tsc"]);
run("Existing backend regression suite", ["--test", ...backend]);
if (!existsSync(join(root, gate.file))) {
  console.error(`Missing ${gate.file}. Add behavioral contract tests named ${gate.pattern} for ${task}.`);
  process.exit(1);
}
const output = run(`Acceptance tests for ${task}`, ["--test", `--test-name-pattern=${gate.pattern}`, gate.file]);
const passed = Number(output.match(/^# pass (\d+)\r?$/m)?.[1] ?? 0);
if (passed < 1) {
  console.error(`No acceptance test passed for ${task}. Add a meaningful test matching ${gate.pattern}.`);
  process.exit(1);
}
if (gate.extraFile) run(`Existing knowledge contracts for ${task}`, ["--test", gate.extraFile]);
if (gate.ui) {
  run("Compile UI", ["node_modules/typescript/bin/tsc", "-p", "ui/tsconfig.json"]);
  run("UI regression tests", ["--test", ...uiTests]);
  if (gate.uiContract) {
    if (!existsSync(join(root, uiContract))) {
      console.error(`Missing ${uiContract}. Add UI behavior tests for ${task}.`);
      process.exit(1);
    }
    const uiPattern = task === "TASK-014" ? "\\[TASK-014\\]" : gate.pattern;
    const uiOutput = run(`UI acceptance tests for ${task}`, ["--test", `--test-name-pattern=${uiPattern}`, uiContract]);
    if (Number(uiOutput.match(/^# pass (\d+)\r?$/m)?.[1] ?? 0) < 1) {
      console.error(`No UI acceptance test passed for ${task}.`);
      process.exit(1);
    }
  }
}
console.log(`\n${task} check passed (${passed} focused acceptance test${passed === 1 ? "" : "s"}).`);
