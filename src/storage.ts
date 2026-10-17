import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./rename-with-retry";
import { readRunEvents } from "./run-events";
import { localSharedSnapshot } from "./shared-metadata";
import { localSharedLessons, NeonEnvironment, NeonMetadata, NeonTransport, neonConfig, psqlNeonTransport } from "./neon-metadata";

type Counts = { runs: number; tasks: number; attempts: number; lessons: number };
type Local = { digest: string; sourceEventPosition: { count: number; runId: string | null; sequence: number | null }; counts: Counts };
type Receipt = { at: string; durationMs: number; digest: string; sourceEventPosition: Local["sourceEventPosition"]; counts: Counts };
type Failure = { at: string; durationMs: number; error: string };
type Connectivity = { at: string; durationMs: number; ok: boolean; error?: string;
  tables?: Record<string, { present: boolean; count: number | null }> };
type EnvironmentReceipt = { lastSuccess: Receipt | null; latestFailedAttempt: Failure | null; lastConnectivityCheck: Connectivity | null };
export type StorageStatus = { operation?: { action: "diagnose" | "sync"; ok: boolean }; environment: NeonEnvironment; configuration: { configured: boolean; destination: { host: string; database: string } | null; error: string | null };
  local: Local; pendingLocalChanges: boolean; lastSuccess: Receipt | null; latestFailedAttempt: Failure | null; lastConnectivityCheck: Connectivity | null };

const empty = (): EnvironmentReceipt => ({ lastSuccess: null, latestFailedAttempt: null, lastConnectivityCheck: null });
const safeError = (error: unknown): string => error instanceof Error && /^(?:Invalid ORCH_NEON_(?:DEVELOPMENT|PRODUCTION)_URL(?: TLS mode)?|Development and production Neon databases must be separate|ORCH_NEON_(?:DEVELOPMENT|PRODUCTION)_URL is required for Neon (?:development|production)|DATABASE_URL requires matching NEON_BRANCH=(?:development|production))$/.test(error.message)
  ? error.message : "Neon connection failed";

export async function neonEnvironmentFile(path: string, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env = { ...base };
  const source = await readFile(path, "utf8");
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error("Invalid environment file");
    const value = match[2];
    if (["ORCH_NEON_DEVELOPMENT_URL", "ORCH_NEON_PRODUCTION_URL", "DATABASE_URL", "NEON_BRANCH"].includes(match[1]))
      env[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, "");
  }
  return env;
}

export class StorageService {
  constructor(private readonly project: string, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly transport: NeonTransport = psqlNeonTransport, private readonly now: () => number = Date.now) {}

  private get path(): string { return join(this.project, ".orch", "storage-receipts.json"); }
  private async receipts(): Promise<Record<NeonEnvironment, EnvironmentReceipt>> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<Record<NeonEnvironment, EnvironmentReceipt>>;
      return { development: value.development ?? empty(), production: value.production ?? empty() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { development: empty(), production: empty() };
      throw error;
    }
  }
  private async save(value: Record<NeonEnvironment, EnvironmentReceipt>): Promise<void> {
    await mkdir(join(this.project, ".orch"), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
      await renameWithRetry(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
  private async local(): Promise<{ local: Local; snapshot: Awaited<ReturnType<typeof localSharedSnapshot>>; lessons: Awaited<ReturnType<typeof localSharedLessons>> }> {
    const events = await readRunEvents(this.project);
    const [snapshot, lessons] = await Promise.all([localSharedSnapshot(this.project, events, true), localSharedLessons(this.project, this.env.ORCH_HOME)]);
    const last = events.at(-1);
    return { snapshot, lessons, local: {
      digest: createHash("sha256").update(JSON.stringify({ snapshot, lessons })).digest("hex"),
      sourceEventPosition: { count: events.length, runId: last?.runId ?? null, sequence: last?.sequence ?? null },
      counts: { runs: snapshot.runs.length, tasks: snapshot.runs.reduce((count, run) => count + run.tasks.length, 0),
        attempts: snapshot.runs.reduce((count, run) => count + run.attempts.length, 0), lessons: lessons.length },
    } };
  }
  async status(environment: NeonEnvironment): Promise<StorageStatus> {
    const [current, receipts] = await Promise.all([this.local(), this.receipts()]);
    let configuration: StorageStatus["configuration"];
    try {
      const { host, database } = neonConfig(environment, this.env);
      configuration = { configured: true, destination: { host, database }, error: null };
    } catch (error) { configuration = { configured: false, destination: null, error: safeError(error) }; }
    const receipt = receipts[environment];
    return { environment, configuration, local: current.local, pendingLocalChanges: receipt.lastSuccess?.digest !== current.local.digest,
      lastSuccess: receipt.lastSuccess, latestFailedAttempt: receipt.latestFailedAttempt, lastConnectivityCheck: receipt.lastConnectivityCheck };
  }
  async diagnose(environment: NeonEnvironment): Promise<StorageStatus> {
    const started = this.now();
    const receipts = await this.receipts();
    try {
      const database = new NeonMetadata(neonConfig(environment, this.env), this.transport);
      const tables = await database.diagnose();
      receipts[environment].lastConnectivityCheck = { at: new Date(started).toISOString(), durationMs: this.now() - started,
        ok: true, tables };
    } catch (error) {
      receipts[environment].lastConnectivityCheck = { at: new Date(started).toISOString(), durationMs: this.now() - started,
        ok: false, error: safeError(error) };
    }
    await this.save(receipts);
    return { ...await this.status(environment), operation: { action: "diagnose", ok: receipts[environment].lastConnectivityCheck!.ok } };
  }
  async sync(environment: NeonEnvironment): Promise<StorageStatus> {
    let ok = false;
    const started = this.now();
    const receipts = await this.receipts();
    try {
      const current = await this.local();
      await new NeonMetadata(neonConfig(environment, this.env), this.transport).sync(current.snapshot, current.lessons);
      ok = true;
      receipts[environment].lastSuccess = { at: new Date(started).toISOString(), durationMs: this.now() - started, ...current.local };
    } catch (error) {
      receipts[environment].latestFailedAttempt = { at: new Date(started).toISOString(), durationMs: this.now() - started, error: safeError(error) };
    }
    await this.save(receipts);
    return { ...await this.status(environment), operation: { action: "sync", ok } };
  }
}
