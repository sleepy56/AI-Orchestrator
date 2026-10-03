import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeExecutor } from "./executor";
import { orchestrate } from "./orchestrator";
import { routeTask } from "./router";
import { TaskGraph } from "./scheduler";
import { TaskSnapshot, TaskSpec } from "./types";

const statePath = join(process.cwd(), "state", "tasks.json");

function graphDemo(): TaskGraph {
  const task = (id: string, dependsOn: string[]): TaskSpec => ({
    id,
    description: `Run ${id}`,
    type: "test",
    difficulty: "easy",
    risk: "low",
    dependsOn,
  });

  return TaskGraph.fromSpecs([
    task("T1", []),
    task("T2", ["T1"]),
    task("T3", ["T1"]),
    task("T4", ["T2", "T3"]),
  ]);
}

async function main(): Promise<void> {
  const isGraphDemo = process.argv.includes("--graph");
  const graph = isGraphDemo
    ? graphDemo()
    : new TaskGraph(JSON.parse(await readFile(statePath, "utf8")) as TaskSnapshot);
  const executor = new FakeExecutor();

  console.log(isGraphDemo ? "Dependency graph: T1 → (T2, T3) → T4" : "Input: Rename UserGoal to Goal");
  for (const task of graph.ready()) {
    console.log(`${task.id} ready → ${routeTask(task).label}`);
  }

  const result = await orchestrate(
    graph,
    executor,
    isGraphDemo
      ? undefined
      : async (snapshot) => writeFile(statePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"),
  );

  for (const [index, batch] of result.batches.entries()) {
    console.log(`Batch ${index + 1}: ${batch.join(" + ")}`);
  }
  for (const call of executor.calls) {
    console.log(`Fake ${call.route} worker ran ${call.taskId} (attempt ${call.attempt})`);
  }
  for (const record of result.snapshot.tasks) {
    const validation = record.attempts.at(-1)?.validation;
    console.log(`${record.spec.id} = ${record.status}; validation ${validation?.passed ? "passed" : "not run or failed"}`);
  }
  if (result.blocked.length) console.log(`Blocked: ${result.blocked.join(", ")}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
