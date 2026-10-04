import { AttemptRecord, ScheduledStatus, TaskRecord, TaskSnapshot, TaskSpec } from "./types";

export class TaskGraph {
  private readonly records = new Map<string, TaskRecord>();

  constructor(snapshot: TaskSnapshot) {
    for (const record of snapshot.tasks) {
      const { spec } = record;
      if (!spec.id.trim()) throw new Error("Task ID cannot be empty");
      if (this.records.has(spec.id)) throw new Error(`Duplicate task ID: ${spec.id}`);
      if (!spec.description.trim()) throw new Error(`Task ${spec.id} needs a description`);
      this.records.set(spec.id, {
        spec: { ...spec, dependsOn: [...spec.dependsOn] },
        status: record.status,
        attempts: [...record.attempts],
        ...(record.failureReason ? { failureReason: record.failureReason } : {}),
      });
    }

    for (const record of this.records.values()) {
      for (const dependency of record.spec.dependsOn) {
        if (!this.records.has(dependency)) {
          throw new Error(`Task ${record.spec.id} has unknown dependency ${dependency}`);
        }
        if (dependency === record.spec.id) {
          throw new Error(`Task ${record.spec.id} depends on itself`);
        }
      }
    }

    this.assertAcyclic();
  }

  static fromSpecs(specs: TaskSpec[]): TaskGraph {
    return new TaskGraph({
      tasks: specs.map((spec) => ({ spec, status: "pending", attempts: [] })),
    });
  }

  private assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Dependency cycle contains ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.get(id).spec.dependsOn) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of this.records.keys()) visit(id);
  }

  get(id: string): TaskRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown task: ${id}`);
    return record;
  }

  status(id: string): ScheduledStatus {
    const record = this.get(id);
    if (record.status !== "pending") return record.status;
    return record.spec.dependsOn.every((dependency) => this.get(dependency).status === "completed")
      ? "ready"
      : "blocked";
  }

  ready(): TaskSpec[] {
    return [...this.records.values()]
      .filter((record) => this.status(record.spec.id) === "ready")
      .map((record) => record.spec);
  }

  blocked(): TaskSpec[] {
    return [...this.records.values()]
      .filter((record) => this.status(record.spec.id) === "blocked")
      .map((record) => record.spec);
  }

  markRunning(id: string): void {
    if (this.status(id) !== "ready") throw new Error(`Task ${id} is not ready`);
    this.get(id).status = "running";
  }

  retry(id: string): void {
    const record = this.get(id);
    if (record.status !== "running" && record.status !== "failed") {
      throw new Error(`Task ${id} must be running or failed before retry`);
    }
    record.status = "pending";
    delete record.failureReason;
  }

  finish(id: string, attempts: AttemptRecord[], passed: boolean): void {
    const record = this.get(id);
    if (record.status !== "running") throw new Error(`Task ${id} is not running`);
    record.attempts.push(...attempts);
    record.status = passed ? "completed" : "failed";
    if (!passed) {
      record.failureReason = attempts.at(-1)?.validation.errors.join("; ") ?? "No attempts";
    }
  }

  snapshot(): TaskSnapshot {
    return {
      tasks: [...this.records.values()].map((record) => ({
        spec: { ...record.spec, dependsOn: [...record.spec.dependsOn] },
        status: record.status,
        attempts: [...record.attempts],
        ...(record.failureReason ? { failureReason: record.failureReason } : {}),
      })),
    };
  }
}
