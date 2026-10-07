import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertReusable, KnowledgeStore } from "./knowledge";
import { PostgresMetadata } from "./postgres-metadata";
import { validateSharedSnapshot } from "./shared-metadata";

export type NeonEnvironment = "development" | "production";
export interface NeonConfig {
  environment: NeonEnvironment;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}
export interface NeonTransport { query(sql: string, config: NeonConfig): Promise<string> }

export function neonConfig(environment: NeonEnvironment, env: NodeJS.ProcessEnv = process.env): NeonConfig {
  const setting = environment === "development" ? "ORCH_NEON_DEVELOPMENT_URL" : "ORCH_NEON_PRODUCTION_URL";
  const otherSetting = environment === "development" ? "ORCH_NEON_PRODUCTION_URL" : "ORCH_NEON_DEVELOPMENT_URL";
  const raw = env[setting];
  if (!raw) throw new Error(`${setting} is required for Neon sync`);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`Invalid ${setting}`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".neon.tech") ||
      !url.username || !url.password || !url.pathname || url.pathname === "/" || url.hash) throw new Error(`Invalid ${setting}`);
  if (url.searchParams.has("sslmode") && !["verify-full", "require"].includes(url.searchParams.get("sslmode")!)) throw new Error(`Invalid ${setting} TLS mode`);
  if (env[otherSetting]) {
    let other: URL;
    try { other = new URL(env[otherSetting]); }
    catch { throw new Error(`Invalid ${otherSetting}`); }
    if (url.hostname === other.hostname && url.pathname === other.pathname && (url.port || "5432") === (other.port || "5432"))
      throw new Error("Development and production Neon databases must be separate");
  }
  return { environment, host: url.hostname, port: url.port || "5432", database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

export const psqlNeonTransport: NeonTransport = {
  query(sql, config) {
    return new Promise((resolve, reject) => {
      const child = spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PGHOST: config.host, PGPORT: config.port, PGDATABASE: config.database,
          PGUSER: config.user, PGPASSWORD: config.password, PGSSLMODE: "verify-full", PGSSLROOTCERT: "system", PGCHANNELBINDING: "require" },
      });
      let output = "";
      let error = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { error += chunk; });
      child.on("error", () => reject(new Error("Neon psql client is unavailable")));
      child.stdin.on("error", () => { /* Child startup failure is reported by the error event. */ });
      child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`Neon query failed: ${error.replaceAll(config.password, "[redacted]").trim() || `exit ${code}`}`)));
      child.stdin.end(sql);
    });
  },
};

export interface SharedLesson { id: string; text: string; taskCategory: string; updatedAt: string; reviewStatus: "approved"; sourceEntryId: string }

export function validateSharedLessons(input: unknown): SharedLesson[] {
  if (!Array.isArray(input)) throw new Error("Invalid shared lessons");
  const ids = new Set<string>();
  return input.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shared lesson");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["id", "text", "taskCategory", "updatedAt", "reviewStatus", "sourceEntryId"].includes(key))) throw new Error("Unknown shared lesson field");
    if (typeof row.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) || ids.has(row.id) ||
        typeof row.sourceEntryId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.sourceEntryId) || row.reviewStatus !== "approved" ||
        !["rename", "refactor", "analysis", "test", "other"].includes(row.taskCategory as string) ||
        typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt)) ||
        typeof row.text !== "string" || row.text.length > 1000) throw new Error("Invalid shared lesson");
    assertReusable(row.text);
    ids.add(row.id);
    return { id: row.id, text: row.text, taskCategory: row.taskCategory as string, updatedAt: row.updatedAt,
      reviewStatus: "approved" as const, sourceEntryId: row.sourceEntryId };
  });
}

export async function localSharedLessons(project: string, home?: string): Promise<SharedLesson[]> {
  const entries = await new KnowledgeStore(project, home).list("global");
  return validateSharedLessons(entries.map((entry) => {
    if (entry.kind !== "note" || entry.scope !== "global") throw new Error("Invalid global lesson for Neon sync");
    return { id: entry.id, text: entry.text, taskCategory: entry.taskCategory, updatedAt: entry.updatedAt,
      reviewStatus: entry.reviewStatus, sourceEntryId: entry.sourceEntryId };
  }));
}

function literal(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

export class NeonMetadata extends PostgresMetadata {
  constructor(readonly config: NeonConfig, private readonly transport: NeonTransport = psqlNeonTransport) { super(); }
  protected query(sql: string): Promise<string> { return this.transport.query(sql, this.config); }
  async migrate(): Promise<void> {
    await super.migrate();
    const source = await readFile(join(__dirname, "..", "migrations", "002_neon_lessons.sql"), "utf8");
    await this.query(`BEGIN;\nSELECT pg_advisory_xact_lock(23023);\n${source}\nINSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;\nCOMMIT;`);
  }
  async sync(input: unknown, lessons: unknown = []): Promise<void> {
    const snapshot = validateSharedSnapshot(input);
    const reviewed = validateSharedLessons(lessons);
    const statements = this.syncStatements(snapshot);
    for (const lesson of reviewed) statements.push(`INSERT INTO shared_global_lessons(id,text,task_category,updated_at) VALUES (
      ${literal(lesson.id)},${literal(lesson.text)},${literal(lesson.taskCategory)},${literal(lesson.updatedAt)})
      ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text,task_category=EXCLUDED.task_category,updated_at=EXCLUDED.updated_at;`);
    await this.query([...statements, "COMMIT;"].join("\n"));
  }
}
