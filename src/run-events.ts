import { open, readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { AttemptRecord, TaskSnapshot } from "./types";

export type RunMode = "simulated" | "live";

export type RunEventData =
  | { type: "run.started"; mode: RunMode; tasks: TaskSnapshot["tasks"]; policyVersion: number }
  | { type: "task.started"; taskId: string }
  | { type: "route.decided"; taskId: string; attempt: number; route: AttemptRecord["route"]; reason: string; policyVersion: number; candidates: Array<{ alias: string; model: string; weight: number }>; chosenAlias?: string; chosenModel?: string; preferenceWeight?: number }
  | { type: "attempt.started"; taskId: string; attempt: number; route: AttemptRecord["route"] }
  | { type: "attempt.finished"; taskId: string; attempt: AttemptRecord; simulated: boolean }
  | { type: "task.finished"; taskId: string; status: "completed" | "failed"; failureReason?: string }
  | { type: "run.finished"; blocked: string[] };

export type RunEvent = RunEventData & { runId: string; sequence: number; at: string };

export function runEventsPath(project: string): string {
  return join(project, ".orch", "runs.jsonl");
}

export class RunEventWriter {
  readonly runId = randomUUID();
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly project: string) {}

  append(data: RunEventData): Promise<void> {
    const event: RunEvent = { ...data, runId: this.runId, sequence: ++this.sequence, at: new Date().toISOString() };
    const write = this.pending.then(async () => {
      const target = runEventsPath(this.project);
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, "a");
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.pending = write;
    return write;
  }
}

export async function readRunEvents(project: string): Promise<RunEvent[]> {
  let content: string;
  try { content = await readFile(runEventsPath(project), "utf8"); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  // A reader can catch the writer before its final newline is visible.
  const lines = content.split(/\r?\n/);
  if (!content.endsWith("\n")) lines.pop();
  return lines.filter(Boolean).map((line, index) => {
    let event: RunEvent;
    try { event = JSON.parse(line) as RunEvent; }
    catch { throw new Error(`Invalid run event at line ${index + 1}`); }
    if (!event.runId || !Number.isInteger(event.sequence) || event.sequence < 1 || !event.type || !event.at) {
      throw new Error(`Invalid run event at line ${index + 1}`);
    }
    return event;
  });
}

export interface RunSummary {
  runId: string;
  mode: RunMode;
  startedAt: string;
  finishedAt?: string;
  lastSequence: number;
  status: "running" | "finished";
}

export function summarizeRuns(events: RunEvent[]): RunSummary[] {
  const runs = new Map<string, RunSummary>();
  for (const event of events) {
    if (event.type === "run.started") {
      runs.set(event.runId, { runId: event.runId, mode: event.mode, startedAt: event.at, lastSequence: event.sequence, status: "running" });
    } else {
      const run = runs.get(event.runId);
      if (!run) continue;
      run.lastSequence = event.sequence;
      if (event.type === "run.finished") {
        run.status = "finished";
        run.finishedAt = event.at;
      }
    }
  }
  return [...runs.values()].reverse();
}
