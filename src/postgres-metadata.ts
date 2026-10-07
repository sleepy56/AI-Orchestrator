import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SharedSnapshot, validateSharedSnapshot } from "./shared-metadata";

const compose = join(__dirname, "..", "compose.yaml");
const migration = join(__dirname, "..", "migrations", "001_shared_metadata.sql");

function literal(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function nullable(value: string | number | undefined): string { return value === undefined ? "NULL" : typeof value === "number" ? String(value) : literal(value); }
function sqlArray(values: string[]): string { return `ARRAY[${values.map(literal).join(",")}]::text[]`; }

async function psql(sql: string, composeProject?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-f", compose, ...(composeProject ? ["-p", composeProject] : []), "exec", "-T", "postgres", "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "orch", "-d", "orch_metadata"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`Postgres command failed: ${error.trim() || `exit ${code}`}`)));
    child.stdin.end(sql);
  });
}

export class PostgresMetadata {
  constructor(private readonly composeProject?: string) {
    if (composeProject && !/^[a-z][a-z0-9_-]{0,40}$/.test(composeProject)) throw new Error("Invalid compose project");
  }
  protected query(sql: string): Promise<string> { return psql(sql, this.composeProject); }
  async migrate(): Promise<void> {
    const source = await readFile(migration, "utf8");
    await this.query(`BEGIN;\nSELECT pg_advisory_xact_lock(23023);\n${source}\nINSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;\nCOMMIT;\n`);
  }
  protected syncStatements(input: unknown): string[] {
    // The full payload is checked before any command reaches Postgres.
    const snapshot: SharedSnapshot = validateSharedSnapshot(input);
    const statements = ["BEGIN;", `INSERT INTO shared_projects(project_id) VALUES (${literal(snapshot.projectId)}) ON CONFLICT(project_id) DO UPDATE SET synced_at = now();`];
    for (const run of snapshot.runs) {
      const key = `${literal(snapshot.projectId)},${literal(run.runId)}`;
      statements.push(`INSERT INTO shared_runs(project_id,run_id,mode,status,started_at,finished_at,last_sequence,policy_version)
        VALUES (${key},${literal(run.mode)},${literal(run.status)},${literal(run.startedAt)},${nullable(run.finishedAt)},${run.lastSequence},${run.policyVersion})
        ON CONFLICT(project_id,run_id) DO UPDATE SET mode=EXCLUDED.mode,status=EXCLUDED.status,started_at=EXCLUDED.started_at,
        finished_at=EXCLUDED.finished_at,last_sequence=EXCLUDED.last_sequence,policy_version=EXCLUDED.policy_version;`);
      statements.push(`DELETE FROM shared_run_tasks WHERE project_id=${literal(snapshot.projectId)} AND run_id=${literal(run.runId)};`);
      for (const task of run.tasks) statements.push(`INSERT INTO shared_run_tasks(project_id,run_id,task_id,category,risk,status,depends_on)
        VALUES (${key},${literal(task.taskId)},${literal(task.category)},${literal(task.risk)},${literal(task.status)},${sqlArray(task.dependsOn)});`);
      for (const attempt of run.attempts) statements.push(`INSERT INTO shared_attempts(project_id,run_id,task_id,attempt,route,passed,model,input_tokens,output_tokens,latency_ms)
        VALUES (${key},${literal(attempt.taskId)},${attempt.attempt},${literal(attempt.route)},${attempt.passed},${nullable(attempt.model)},
        ${nullable(attempt.inputTokens)},${nullable(attempt.outputTokens)},${nullable(attempt.latencyMs)});`);
    }
    return statements;
  }
  async sync(input: unknown): Promise<void> {
    await this.query([...this.syncStatements(input), "COMMIT;"].join("\n"));
  }
  async runs(projectId: string): Promise<Record<string, unknown>[]> {
    validateSharedSnapshot({ version: 1, projectId, runs: [] });
    const result = await this.query(`SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM (
      SELECT run_id AS "runId", mode, status, started_at AS "startedAt", finished_at AS "finishedAt",
      last_sequence AS "lastSequence", policy_version AS "policyVersion",
      (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM
        (SELECT task_id AS "taskId", category, risk, status, depends_on AS "dependsOn"
         FROM shared_run_tasks WHERE project_id=shared_runs.project_id AND run_id=shared_runs.run_id ORDER BY task_id) t) AS tasks,
      (SELECT COALESCE(json_agg(row_to_json(a)), '[]'::json) FROM
        (SELECT task_id AS "taskId", attempt, route, passed, model, input_tokens AS "inputTokens",
          output_tokens AS "outputTokens", latency_ms AS "latencyMs"
         FROM shared_attempts WHERE project_id=shared_runs.project_id AND run_id=shared_runs.run_id ORDER BY task_id,attempt) a) AS attempts
      FROM shared_runs WHERE project_id=${literal(projectId)} ORDER BY started_at DESC) r;`);
    return JSON.parse(result) as Record<string, unknown>[];
  }
}
