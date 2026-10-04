import { spawn } from "node:child_process";
import { Executor } from "./executor";
import { ModelRegistry, selectModel } from "./models";
import { ExecutionResult, Route, TaskSpec } from "./types";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export class ProviderConfigurationError extends Error {}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
}

export interface CodexRunResult {
  exitCode: number | null;
  finalResponse: string;
  stderr: string;
  inputTokens?: number;
  outputTokens?: number;
  timedOut: boolean;
}

export class CodexExecutor implements Executor {
  readonly parallel = false;

  constructor(
    private readonly project: string,
    private readonly registry: ModelRegistry,
    private readonly checkCommand: string,
    private readonly notes: string[] = [],
    private readonly timeoutMs = 600_000,
  ) {
    if (!checkCommand.trim()) throw new Error("Live Codex runs require --check with a project validation command");
  }

  async execute(task: TaskSpec, route: Route, attempt: number): Promise<ExecutionResult> {
    let profile;
    try { profile = selectModel(this.registry, route); }
    catch (error) { throw new ProviderConfigurationError(error instanceof Error ? error.message : String(error)); }
    const started = Date.now();
    console.log(`${task.id}: Codex ${profile.model} (${profile.effort}), attempt ${attempt}`);
    const prompt = [
      `Complete task ${task.id} in this repository: ${task.description}`,
      `Task type: ${task.type}. Difficulty: ${task.difficulty}. Risk: ${task.risk}.`,
      "Respect the repository instructions. Make only the changes needed for this task.",
      ...(attempt > 1 ? ["This is a retry. Inspect the existing repository changes first and finish or verify that work; do not start the task over."] : []),
      ...(this.notes.length ? ["Project and global Orch knowledge:\n" + this.notes.join("\n")] : []),
      "Explain the changes and any tests you ran in your final response.",
    ].join("\n");
    const args = [
      "exec", "--json", "--sandbox", "workspace-write", "-C", this.project,
      "-m", profile.model, "-c", `model_reasoning_effort="${profile.effort}"`, prompt,
    ];
    const launch = await resolveCodexLaunch();
    let result;
    try { result = await runCodex(launch.command, [...launch.argsPrefix, ...args], this.project, this.timeoutMs, (status) => console.log(`${task.id}: ${status}`)); }
    catch (error) { throw new ProviderConfigurationError(error instanceof Error ? error.message : String(error)); }
    let error = result.timedOut
      ? `Codex produced no output for ${Math.ceil(this.timeoutMs / 1000)} seconds`
      : result.exitCode === 0 ? undefined : `Codex exited ${result.exitCode}: ${result.stderr || "no details"}`;
    if (!error) {
      console.log(`${task.id}: running validation command`);
      const check = await runCheck(this.checkCommand, this.project);
      if (check.exitCode !== 0) error = `Validation command failed (${check.exitCode}): ${check.output}`;
    }
    return {
      taskId: task.id, route, attempt, model: `${profile.provider}:${profile.model}`,
      succeeded: !error, output: result.finalResponse,
      retryable: result.exitCode === 0 && !result.timedOut,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      latencyMs: Date.now() - started, checkCommand: this.checkCommand,
      ...(error ? { error } : {}),
    };
  }
}

export async function smokeCodex(project: string, registry: ModelRegistry, timeoutMs: number): Promise<{
  ok: boolean; model: string; reason: string;
}> {
  const route: Route = { worker: "luna", effort: "low", label: "luna-low" };
  const profile = selectModel(registry, route);
  const launch = await resolveCodexLaunch();
  const args = [
    "exec", "--json", "--ephemeral", "--sandbox", "read-only", "-C", project,
    "-m", profile.model, "-c", `model_reasoning_effort="${profile.effort}"`,
    "Reply with the single word READY. Do not modify any files.",
  ];
  console.log(`Checking Codex ${profile.model} with a read-only task...`);
  try {
    const result = await runCodex(launch.command, [...launch.argsPrefix, ...args], project, timeoutMs, (status) => console.log(`Codex: ${status}`));
    if (result.timedOut) return { ok: false, model: profile.model, reason: `Codex produced no output for ${Math.ceil(timeoutMs / 1000)} seconds` };
    if (result.exitCode !== 0) return { ok: false, model: profile.model, reason: `Codex exited ${result.exitCode}: ${result.stderr || "no details"}` };
    if (result.finalResponse.trim() !== "READY") return { ok: false, model: profile.model, reason: `Unexpected Codex smoke response: ${result.finalResponse.trim() || "no final response"}` };
    return { ok: true, model: profile.model, reason: "" };
  } catch (error) {
    return { ok: false, model: profile.model, reason: error instanceof Error ? error.message : String(error) };
  }
}

export class ClaudeExecutor implements Executor {
  async execute(): Promise<ExecutionResult> {
    throw new Error("Claude is registered but unavailable. Add a Claude provider connection before enabling it.");
  }
}

interface CodexLaunch {
  command: string;
  argsPrefix: string[];
}

export async function resolveCodexLaunch(pathValue = process.env.PATH ?? "", platform = process.platform): Promise<CodexLaunch> {
  if (platform !== "win32") return { command: "codex", argsPrefix: [] };
  const directories = pathValue.split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const executable = join(directory, "codex.exe");
    try { await access(executable); return { command: executable, argsPrefix: [] }; }
    catch { /* Continue to the next PATH entry. */ }
  }
  for (const directory of directories) {
    const npmShim = join(directory, "codex.cmd");
    const entryPoint = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    try {
      await access(npmShim);
      await access(entryPoint);
      return { command: process.execPath, argsPrefix: [entryPoint] };
    } catch { /* Continue to the next PATH entry. */ }
  }
  throw new ProviderConfigurationError("Codex CLI was not found on PATH. Install @openai/codex or add its executable directory to PATH.");
}

export async function runCodex(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onProgress?: (status: string) => void,
): Promise<CodexRunResult> {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Codex timeout must be positive");
    // Codex treats piped stdin as extra prompt context and waits for EOF.
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    let stderr = "";
    let finalResponse = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let timedOut = false;
    let lastEvent = "";
    let timer: NodeJS.Timeout | undefined;
    const resetIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    };
    resetIdleTimer();
    const heartbeat = setInterval(() => {
      onProgress?.(`waiting for Codex (${Math.round((Date.now() - started) / 1000)}s; last event: ${lastEvent || "none"})`);
    }, 10_000);
    const started = Date.now();
    function clearTimers() { clearTimeout(timer); clearInterval(heartbeat); }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      resetIdleTimer();
      pending += chunk;
      let end = pending.indexOf("\n");
      while (end >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as CodexEvent;
            if (event.type) {
              lastEvent = event.type;
              if (["thread.started", "turn.started", "turn.completed", "turn.failed", "error"].includes(event.type)) {
                onProgress?.(event.type);
              } else if (event.type.startsWith("item.") && event.item?.type) {
                onProgress?.(`${event.type}: ${event.item.type}`);
              }
            }
            if (event.type === "item.completed" && event.item?.type === "agent_message") finalResponse = event.item.text ?? "";
            if ((event.type === "error" || event.type === "turn.failed") && event.message) stderr = (stderr + "\n" + event.message).slice(-8192);
            if (event.type === "turn.completed" && event.usage) {
              inputTokens = event.usage.input_tokens;
              outputTokens = event.usage.output_tokens;
            }
          } catch { /* Ignore malformed progress; exit status and final message decide the result. */ }
        }
        end = pending.indexOf("\n");
      }
      if (pending.length > 1024 * 1024) pending = pending.slice(-1024 * 1024);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { resetIdleTimer(); stderr = (stderr + chunk).slice(-8192); });
    child.on("error", (error) => {
      clearTimers();
      reject(new Error(`Could not start Codex CLI: ${error.message}. Install Codex CLI and run codex login.`));
    });
    child.on("close", (exitCode) => {
      clearTimers();
      resolve({ exitCode, finalResponse, stderr: stderr.trim(), inputTokens, outputTokens, timedOut });
    });
  });
}

async function runCheck(command: string, cwd: string): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, timeout: 10 * 60_000 });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => { output = (output + chunk).slice(-8192); });
    }
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, output: output.trim().slice(-1000) }));
  });
}
