#!/usr/bin/env node
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FakeExecutor } from "./executor";
import { orchestrate } from "./orchestrator";
import { routeTask } from "./router";
import { TaskGraph } from "./scheduler";
import { Difficulty, Risk, TaskSnapshot, TaskSpec, TaskType } from "./types";

type Options = Record<string, string | boolean>;

const taskTypes: TaskType[] = ["rename", "refactor", "analysis", "test", "other"];
const difficulties: Difficulty[] = ["easy", "moderate", "hard"];
const risks: Risk[] = ["low", "medium", "high"];

function usage(): string {
  return [
    "orch — dependency-aware task runner (fake workers only)",
    "",
    "Usage:",
    "  orch init [directory]",
    "  orch plan <description> [--type rename|refactor|analysis|test|other]",
    "       [--difficulty easy|moderate|hard] [--risk low|medium|high]",
    "       [--after TASK-001,TASK-002] [--project directory]",
    "  orch status [--project directory]",
    "  orch run [--project directory]",
    "  orch skill install [--to skills-directory] [--force]",
    "  orch help",
    "",
    "Plan creates one task; it does not split a goal into subtasks.",
    "Run simulates workers and does not edit project code.",
  ].join("\n");
}

function parseArguments(args: string[], allowed: string[]): { positionals: string[]; options: Options } {
  const positionals: string[] = [];
  const options: Options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!allowed.includes(name)) throw new Error(`Unknown option: ${token}`);
    if (name === "force") {
      options[name] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Option ${token} needs a value`);
    if (options[name] !== undefined) throw new Error(`Option ${token} was provided twice`);
    options[name] = value;
  }
  return { positionals, options };
}

function option(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`Invalid ${name}: ${value}. Choose ${allowed.join(", ")}`);
}

function statePath(project: string): string {
  return join(project, ".orch", "tasks.json");
}

async function loadGraph(project: string): Promise<TaskGraph> {
  let source: string;
  try {
    source = await readFile(statePath(project), "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`No orch project at ${project}. Run orch init first.`);
    throw error;
  }
  const snapshot: unknown = JSON.parse(source);
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray((snapshot as TaskSnapshot).tasks)) {
    throw new Error("Invalid .orch/tasks.json: expected a tasks array");
  }
  return new TaskGraph(snapshot as TaskSnapshot);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function saveSnapshot(project: string, snapshot: TaskSnapshot): Promise<void> {
  const target = statePath(project);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function nextId(snapshot: TaskSnapshot): string {
  const existing = new Set(snapshot.tasks.map((record) => record.spec.id));
  let number = Math.max(0, ...snapshot.tasks.map((record) => {
    const match = /^TASK-(\d+)$/.exec(record.spec.id);
    return match ? Number(match[1]) : 0;
  })) + 1;
  while (existing.has(`TASK-${String(number).padStart(3, "0")}`)) number += 1;
  return `TASK-${String(number).padStart(3, "0")}`;
}

async function init(args: string[]): Promise<void> {
  const { positionals } = parseArguments(args, []);
  if (positionals.length > 1) throw new Error("init accepts at most one directory");
  const project = resolve(positionals[0] ?? process.cwd());
  const target = statePath(project);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, '{\n  "tasks": []\n}\n', { encoding: "utf8", flag: "wx" });
    console.log(`Initialized orch in ${project}`);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      console.log(`Already initialized: ${project}`);
      return;
    }
    throw error;
  }
}

async function plan(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["type", "difficulty", "risk", "after", "project"]);
  const description = positionals.join(" ").trim();
  if (!description) throw new Error("plan needs a task description");
  const project = resolve(option(options, "project") ?? process.cwd());
  const graph = await loadGraph(project);
  const snapshot = graph.snapshot();
  const dependsOn = option(options, "after")?.split(",").map((id) => id.trim()) ?? [];
  if (dependsOn.some((id) => !id) || new Set(dependsOn).size !== dependsOn.length) {
    throw new Error("--after needs unique, nonempty task IDs");
  }
  const spec: TaskSpec = {
    id: nextId(snapshot),
    description,
    type: oneOf(option(options, "type"), taskTypes, "other", "type"),
    difficulty: oneOf(option(options, "difficulty"), difficulties, "moderate", "difficulty"),
    risk: oneOf(option(options, "risk"), risks, "medium", "risk"),
    dependsOn,
  };
  snapshot.tasks.push({ spec, status: "pending", attempts: [] });
  new TaskGraph(snapshot); // Validate dependencies and cycles before writing.
  await saveSnapshot(project, snapshot);
  console.log(`Added ${spec.id}: ${spec.description}`);
  console.log(`Route: ${routeTask(spec).label}; dependencies: ${dependsOn.join(", ") || "none"}`);
}

async function status(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["project"]);
  if (positionals.length) throw new Error("status does not accept positional arguments");
  const graph = await loadGraph(resolve(option(options, "project") ?? process.cwd()));
  const records = graph.snapshot().tasks;
  if (!records.length) {
    console.log("No tasks planned. Use orch plan to add one.");
    return;
  }
  for (const record of records) {
    console.log(`${record.spec.id}  ${graph.status(record.spec.id)}  ${record.spec.description}  (${record.attempts.length} attempts)`);
  }
}

async function run(args: string[]): Promise<number> {
  const { positionals, options } = parseArguments(args, ["project"]);
  if (positionals.length) throw new Error("run does not accept positional arguments");
  const project = resolve(option(options, "project") ?? process.cwd());
  const graph = await loadGraph(project);
  console.log("Running with fake workers; project code will not be changed.");
  const executor = new FakeExecutor();
  const result = await orchestrate(graph, executor, (snapshot) => saveSnapshot(project, snapshot));
  for (const [index, batch] of result.batches.entries()) {
    console.log(`Batch ${index + 1}: ${batch.join(" + ")}`);
  }
  for (const call of executor.calls) {
    console.log(`${call.taskId}: fake ${call.route} attempt ${call.attempt}`);
  }
  for (const record of result.snapshot.tasks) {
    console.log(`${record.spec.id}: ${record.status}`);
  }
  if (result.blocked.length) console.log(`Blocked: ${result.blocked.join(", ")}`);
  return result.snapshot.tasks.some((record) => record.status === "failed") || result.blocked.length ? 1 : 0;
}

async function installSkill(args: string[]): Promise<void> {
  const { positionals, options } = parseArguments(args, ["to", "force"]);
  if (positionals.length) throw new Error("skill install does not accept positional arguments");
  const source = resolve(__dirname, "..", "skills", "orch", "SKILL.md");
  const root = resolve(option(options, "to") ?? join(homedir(), ".agents", "skills"));
  const target = join(root, "orch", "SKILL.md");
  const content = await readFile(source, "utf8");
  try {
    const existing = await readFile(target, "utf8");
    if (existing === content) {
      console.log(`Skill already current: ${target}`);
      return;
    }
    if (options.force !== true) throw new Error(`Skill already exists at ${target}; use --force to replace it`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log(`Installed Codex skill: ${target}`);
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      return 0;
    case "init":
      await init(rest);
      return 0;
    case "plan":
      await plan(rest);
      return 0;
    case "status":
      await status(rest);
      return 0;
    case "run":
      return run(rest);
    case "skill":
      if (rest[0] !== "install") throw new Error("Use orch skill install");
      await installSkill(rest.slice(1));
      return 0;
    default:
      throw new Error(`Unknown command: ${command}. Run orch help.`);
  }
}

main(process.argv.slice(2)).then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    console.error(`orch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
