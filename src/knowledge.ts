import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AttemptRecord, TaskSpec } from "./types";

export type KnowledgeScope = "project" | "global";

export interface NoteEntry {
  kind: "note";
  at: string;
  text: string;
}

export interface AttemptEntry {
  kind: "attempt";
  at: string;
  taskId: string;
  taskType: TaskSpec["type"];
  difficulty: TaskSpec["difficulty"];
  risk: TaskSpec["risk"];
  route: string;
  model?: string;
  passed: boolean;
  errors: string[];
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  checkCommand?: string;
  simulated: boolean;
}

export type KnowledgeEntry = NoteEntry | AttemptEntry;

export class KnowledgeStore {
  constructor(readonly project: string, readonly home = process.env.ORCH_HOME ?? join(homedir(), ".orch")) {}

  path(scope: KnowledgeScope): string {
    return scope === "project" ? join(this.project, ".orch", "knowledge.jsonl") : join(this.home, "knowledge.jsonl");
  }

  async append(scope: KnowledgeScope, entry: KnowledgeEntry): Promise<void> {
    const target = this.path(scope);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async note(scope: KnowledgeScope, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Knowledge note cannot be empty");
    await this.append(scope, { kind: "note", at: new Date().toISOString(), text: text.trim() });
  }

  async recordAttempt(scope: KnowledgeScope, task: TaskSpec, attempt: AttemptRecord, simulated: boolean): Promise<void> {
    await this.append(scope, {
      kind: "attempt", at: new Date().toISOString(), taskId: task.id,
      taskType: task.type, difficulty: task.difficulty, risk: task.risk,
      route: attempt.route.label, model: attempt.model,
      passed: attempt.validation.passed, errors: scope === "global" ? [] : attempt.validation.errors,
      inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, simulated,
      latencyMs: attempt.latencyMs, checkCommand: scope === "global" ? undefined : attempt.checkCommand,
    });
  }

  async list(scope: KnowledgeScope): Promise<KnowledgeEntry[]> {
    let content: string;
    try {
      content = await readFile(this.path(scope), "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as KnowledgeEntry; }
      catch { throw new Error(`Invalid knowledge entry at line ${index + 1}`); }
    });
  }
}
