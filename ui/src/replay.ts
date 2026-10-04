import type { Run, RunEvent, Task, TaskStatus } from "./api";

export interface ReplayFrame {
  tasks: Task[];
  events: RunEvent[];
  run: Run;
}

type SnapshotTask = Omit<Task, "displayStatus">;

function displayStatus(task: SnapshotTask, byId: Map<string, SnapshotTask>): TaskStatus {
  if (task.status !== "pending") return task.status;
  return task.spec.dependsOn.every((id) => byId.get(id)?.status === "completed") ? "ready" : "blocked";
}

export function replayRun(run: Run, allEvents: RunEvent[], sequence: number): ReplayFrame {
  const events = allEvents.filter((event) => event.sequence <= sequence).sort((a, b) => a.sequence - b.sequence);
  const start = events.find((event) => event.type === "run.started");
  if (!start?.tasks) throw new Error("Run start snapshot is unavailable");
  const tasks = start.tasks.map((task) => ({
    ...task,
    spec: { ...task.spec, dependsOn: [...task.spec.dependsOn] },
    attempts: [...task.attempts],
  }));
  const byId = new Map(tasks.map((task) => [task.spec.id, task]));
  for (const event of events) {
    const task = event.taskId ? byId.get(event.taskId) : undefined;
    if (!task) continue;
    if (event.type === "task.started") {
      task.status = "running";
      delete task.failureReason;
    } else if (event.type === "attempt.finished" && typeof event.attempt === "object") {
      task.attempts.push(event.attempt);
    } else if (event.type === "task.finished" && (event.status === "completed" || event.status === "failed")) {
      task.status = event.status;
      if (event.status === "failed") task.failureReason = event.failureReason ?? task.attempts.at(-1)?.validation.errors.join("; ") ?? "Task failed";
      else delete task.failureReason;
    }
  }
  return {
    tasks: tasks.map((task) => ({ ...task, displayStatus: displayStatus(task, byId) })),
    events,
    run: { ...run, status: events.some((event) => event.type === "run.finished") ? "finished" : "running" },
  };
}
