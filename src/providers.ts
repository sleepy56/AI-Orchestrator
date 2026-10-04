import { spawn } from "node:child_process";
import { Executor } from "./executor";
import { ModelRegistry, selectModel } from "./models";
import { ExecutionResult, Route, TaskSpec } from "./types";

export class ProviderConfigurationError extends Error {}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class CodexExecutor implements Executor {
  readonly parallel = false;

  constructor(
    private readonly project: string,
    private readonly registry: ModelRegistry,
    private readonly checkCommand: string,
    private readonly notes: string[] = [],
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
      ...(this.notes.length ? ["Project and global Orch knowledge:\n" + this.notes.join("\n")] : []),
      "Explain the changes and any tests you ran in your final response.",
    ].join("\n");
    const args = [
      "exec", "--json", "--sandbox", "workspace-write", "-C", this.project,
      "-m", profile.model, "-c", `model_reasoning_effort="${profile.effort}"`, prompt,
    ];
    const command = process.platform === "win32" ? "codex.exe" : "codex";
    let result;
    try { result = await runCodex(command, args, this.project); }
    catch (error) { throw new ProviderConfigurationError(error instanceof Error ? error.message : String(error)); }
    let error = result.exitCode === 0 ? undefined : `Codex exited ${result.exitCode}: ${result.stderr || "no details"}`;
    if (!error) {
      console.log(`${task.id}: running validation command`);
      const check = await runCheck(this.checkCommand, this.project);
      if (check.exitCode !== 0) error = `Validation command failed (${check.exitCode}): ${check.output}`;
    }
    return {
      taskId: task.id, route, attempt, model: `${profile.provider}:${profile.model}`,
      succeeded: !error, output: result.finalResponse,
      retryable: result.exitCode === 0,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      latencyMs: Date.now() - started, checkCommand: this.checkCommand,
      ...(error ? { error } : {}),
    };
  }
}

export class ClaudeExecutor implements Executor {
  async execute(): Promise<ExecutionResult> {
    throw new Error("Claude is registered but unavailable. Add a Claude provider connection before enabling it.");
  }
}

async function runCodex(command: string, args: string[], cwd: string): Promise<{
  exitCode: number | null; finalResponse: string; stderr: string; inputTokens?: number; outputTokens?: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, timeout: 30 * 60_000 });
    let pending = "";
    let stderr = "";
    let finalResponse = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let end = pending.indexOf("\n");
      while (end >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line) {
          try {
            const event = JSON.parse(line) as CodexEvent;
            if (event.type === "item.completed" && event.item?.type === "agent_message") finalResponse = event.item.text ?? "";
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
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.on("error", (error) => reject(new Error(`Could not start Codex CLI: ${error.message}. Install Codex CLI and run codex login.`)));
    child.on("close", (exitCode) => resolve({ exitCode, finalResponse, stderr: stderr.trim(), inputTokens, outputTokens }));
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
