import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { renameWithRetry } from "./rename-with-retry";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AttemptRecord, TaskSpec, TaskType } from "./types";

export type KnowledgeScope = "project" | "global";
export type ReviewStatus = "pending" | "approved" | "rejected";

interface Provenance {
  id: string;
  scope: KnowledgeScope;
  sourceProject: string | null;
  sourceRunId: string | null;
  sourceEntryId?: string;
}

export interface KnowledgeAudit {
  id: string;
  at: string;
  action: "add" | "observe" | "review" | "edit" | "promote" | "remove";
  entryId: string;
  scope: KnowledgeScope;
  sourceEntryId?: string;
  fromStatus?: ReviewStatus;
  toStatus?: ReviewStatus;
  textDigest?: string;
  nextTextDigest?: string;
}

export interface NoteEntry extends Provenance {
  kind: "note";
  text: string;
  taskCategory: TaskType;
  createdAt: string;
  updatedAt: string;
  reviewStatus: ReviewStatus;
}

export interface AttemptEntry extends Provenance {
  kind: "attempt";
  at: string;
  taskId: string;
  attemptNumber?: number;
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

export interface CandidateEntry extends Provenance {
  kind: "candidate";
  fingerprint: string;
  text: string;
  taskCategory: TaskType;
  createdAt: string;
  updatedAt: string;
  reviewStatus: ReviewStatus;
  evidence: Array<{ attemptId: string; runId: string; taskId: string }>;
  lessonId?: string;
}

export type KnowledgeEntry = NoteEntry | AttemptEntry | CandidateEntry;

export interface SelectedLesson {
  entry: NoteEntry;
  reason: string;
}

const MAX_RETRIEVED_LESSONS = 5;
const retrievalStopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with", "task", "tasks", "use", "using", "when"]);

function retrievalTerms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [])
    .map((word) => word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word)
    .filter((word) => word.length > 2 && !retrievalStopWords.has(word)));
}

function mentionedRisks(text: string): Set<TaskSpec["risk"]> {
  const matches = text.toLowerCase().match(/\b(?:low|medium|high|critical)\s+risk\b|\brisk\s+(?:low|medium|high|critical)\b/g) ?? [];
  return new Set(matches.map((match) => (match.match(/low|medium|high|critical/) ?? [])[0] as TaskSpec["risk"]));
}

// Cloud adapters can implement this contract later; current callers use local storage only.
export interface KnowledgeStorage {
  list(scope: KnowledgeScope): Promise<KnowledgeEntry[]>;
  append(scope: KnowledgeScope, entry: KnowledgeEntry): Promise<void>;
  change(scope: KnowledgeScope, id: string, action: KnowledgeAudit["action"], transform: (entry: KnowledgeEntry) => KnowledgeEntry | null): Promise<KnowledgeEntry | null>;
  audit(scope: KnowledgeScope): Promise<KnowledgeAudit[]>;
  recordOutcome(attempt: AttemptEntry, candidate: CandidateEntry | null): Promise<void>;
  reviewCandidate(id: string, status: ReviewStatus, now: string): Promise<CandidateEntry>;
}

interface KnowledgeFile {
  schemaVersion: 1;
  scope: KnowledgeScope;
  legacyImportedLines: number;
  legacyDigest: string;
  entries: KnowledgeEntry[];
  audit?: KnowledgeAudit[];
}

function auditEvent(action: KnowledgeAudit["action"], scope: KnowledgeScope, entry: KnowledgeEntry, next?: KnowledgeEntry | null): KnowledgeAudit {
  return { id: randomUUID(), at: new Date().toISOString(), action, entryId: entry.id, scope,
    ...(entry.sourceEntryId ? { sourceEntryId: entry.sourceEntryId } : {}),
    ...(entry.kind !== "attempt" ? { textDigest: digest(entry.text) } : {}),
    ...(next && next.kind !== "attempt" ? { nextTextDigest: digest(next.text) } : {}),
    ...(entry.kind !== "attempt" ? { fromStatus: entry.reviewStatus } : {}),
    ...(next && next.kind !== "attempt" ? { toStatus: next.reviewStatus } : {}),
  };
}

export function assertReusable(text: string): void {
  // This is a guardrail for obvious leaks; explicit human review remains required.
  if (!text.trim()) throw new Error("Global lessons cannot be empty");
  const privateDetail = /(?:[\\/]|\b\S+\.(?:ts|tsx|js|json|py|ps1|sh|md)\b|\b[\w.+-]+@[\w.-]+\b|[`{};=<>]|\bTASK-\d+\b|\b(?:const|function|import|export|class)\s+\S+|\b(?:npm|npx|node|python|pytest|git|curl)\s+\S+|\b(?:failed|failure|error|secret|token|password|credential|stack trace)\b)/i;
  if (privateDetail.test(text)) throw new Error("Global lessons must be generalized: remove paths, code, commands, checks, failures, and identifying details before promotion");
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectId(project: string): string {
  const path = resolve(project);
  return `project-${digest(process.platform === "win32" ? path.toLowerCase() : path).slice(0, 24)}`;
}

function legacyEntry(raw: unknown, scope: KnowledgeScope, line: number, sourceProject: string): KnowledgeEntry {
  if (!raw || typeof raw !== "object") throw new Error(`Invalid knowledge entry at line ${line}`);
  const value = raw as Record<string, unknown>;
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) throw new Error(`Invalid knowledge timestamp at line ${line}`);
  const id = `legacy-${digest(`${scope}:${line}:${JSON.stringify(value)}`)}`;
  const provenance = { id, scope, sourceProject: scope === "project" ? sourceProject : null, sourceRunId: null };
  if (value.kind === "note" && typeof value.text === "string") {
    return { ...value, ...provenance, kind: "note", text: value.text, taskCategory: "other", createdAt: value.at, updatedAt: value.at, reviewStatus: "pending" } as NoteEntry;
  }
  if (value.kind === "attempt" && typeof value.taskId === "string" && typeof value.simulated === "boolean") {
    return { ...value, ...provenance, kind: "attempt" } as unknown as AttemptEntry;
  }
  throw new Error(`Invalid knowledge entry at line ${line}`);
}

export class LocalKnowledgeStorage implements KnowledgeStorage {
  constructor(readonly project: string, readonly home: string) {}

  path(scope: KnowledgeScope): string {
    return scope === "project" ? join(this.project, ".orch", "knowledge.v1.json") : join(this.home, "knowledge.v1.json");
  }

  legacyPath(scope: KnowledgeScope): string {
    return scope === "project" ? join(this.project, ".orch", "knowledge.jsonl") : join(this.home, "knowledge.jsonl");
  }

  private async locked<T>(scope: KnowledgeScope, action: () => Promise<T>): Promise<T> {
    const target = this.path(scope);
    await mkdir(dirname(target), { recursive: true });
    const lock = `${target}.lock`;
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await open(lock, "wx"); break; }
      catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    if (!handle) throw new Error(`Knowledge store is locked: ${lock}`);
    try { return await action(); }
    finally { await handle.close(); await rm(lock, { force: true }); }
  }

  private async load(scope: KnowledgeScope): Promise<{ file: KnowledgeFile; changed: boolean }> {
    const target = this.path(scope);
    let file: KnowledgeFile;
    try {
      const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid knowledge store");
      file = parsed as KnowledgeFile;
      if (file.schemaVersion !== 1) throw new Error(`Unsupported knowledge schema version: ${file.schemaVersion}`);
      if (file.scope !== scope || !Array.isArray(file.entries) || !Number.isSafeInteger(file.legacyImportedLines) || file.legacyImportedLines < 0 || typeof file.legacyDigest !== "string") {
        throw new Error(`Invalid knowledge store: ${target}`);
      }
      const ids = file.entries.map((entry) => entry.id);
      if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) throw new Error(`Invalid knowledge IDs: ${target}`);
    } catch (error) {
      if (!missing(error)) throw error;
      file = { schemaVersion: 1, scope, legacyImportedLines: 0, legacyDigest: digest(""), entries: [], audit: [] };
    }

    let legacy: string;
    try { legacy = await readFile(this.legacyPath(scope), "utf8"); }
    catch (error) {
      if (!missing(error)) throw error;
      return { file, changed: false };
    }
    const lines = legacy.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length < file.legacyImportedLines || digest(lines.slice(0, file.legacyImportedLines).join("\n")) !== file.legacyDigest) {
      throw new Error(`Legacy knowledge log changed after import: ${this.legacyPath(scope)}`);
    }
    if (lines.length === file.legacyImportedLines) return { file, changed: false };
    for (let index = file.legacyImportedLines; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(lines[index]); }
      catch { throw new Error(`Invalid knowledge entry at line ${index + 1}`); }
      file.entries.push(legacyEntry(raw, scope, index + 1, projectId(this.project)));
    }
    file.legacyImportedLines = lines.length;
    file.legacyDigest = digest(lines.join("\n"));
    return { file, changed: true };
  }

  private async save(scope: KnowledgeScope, file: KnowledgeFile): Promise<void> {
    const target = this.path(scope);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx");
      try { await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await renameWithRetry(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }

  async list(scope: KnowledgeScope): Promise<KnowledgeEntry[]> {
    return this.locked(scope, async () => {
      const { file, changed } = await this.load(scope);
      if (changed) await this.save(scope, file);
      return file.entries;
    });
  }

  async append(scope: KnowledgeScope, entry: KnowledgeEntry): Promise<void> {
    if (entry.scope !== scope) throw new Error("Knowledge scope mismatch");
    if (entry.kind === "candidate") throw new Error("Candidates must be created from recorded live outcomes");
    if (scope === "global" && (entry.kind !== "note" || entry.reviewStatus !== "approved" || !entry.sourceEntryId)) {
      throw new Error("Global knowledge requires a reviewed project lesson and provenance");
    }
    if (scope === "global" && entry.kind === "note") {
      assertReusable(entry.text);
      const allowed = new Set(["kind", "id", "scope", "sourceProject", "sourceRunId", "sourceEntryId", "text", "taskCategory", "createdAt", "updatedAt", "reviewStatus"]);
      if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error("Global knowledge contains a field outside the lesson allowlist");
      const source = (await this.list("project")).find((item) => item.id === entry.sourceEntryId);
      if (!source || source.kind !== "note" || source.reviewStatus !== "approved" || source.text !== entry.text ||
          source.taskCategory !== entry.taskCategory || source.sourceProject !== entry.sourceProject || source.sourceRunId !== entry.sourceRunId) {
        throw new Error("Global knowledge must match an approved project note");
      }
    }
    await this.locked(scope, async () => {
      const { file } = await this.load(scope);
      if (file.entries.some((existing) => existing.id === entry.id)) throw new Error(`Duplicate knowledge ID: ${entry.id}`);
      if (scope === "global" && file.entries.some((existing) => existing.sourceEntryId === entry.sourceEntryId)) throw new Error(`Project note already promoted: ${entry.sourceEntryId}`);
      file.entries.push(entry);
      (file.audit ??= []).push(auditEvent(scope === "global" ? "promote" : "add", scope, entry, entry));
      await this.save(scope, file);
    });
  }

  async recordOutcome(attempt: AttemptEntry, candidate: CandidateEntry | null): Promise<void> {
    if (attempt.scope !== "project" || candidate?.scope === "global") throw new Error("Run evidence stays in project knowledge");
    await this.locked("project", async () => {
      const { file } = await this.load("project");
      if (attempt.sourceRunId && attempt.attemptNumber !== undefined) {
        const repeated = file.entries.find((entry): entry is AttemptEntry => entry.kind === "attempt" &&
          entry.sourceRunId === attempt.sourceRunId && entry.taskId === attempt.taskId && entry.attemptNumber === attempt.attemptNumber);
        if (repeated) {
          if (repeated.passed !== attempt.passed || repeated.simulated !== attempt.simulated || repeated.route !== attempt.route || repeated.model !== attempt.model) {
            throw new Error(`Conflicting outcome for ${attempt.sourceRunId}/${attempt.taskId}/${attempt.attemptNumber}`);
          }
          return;
        }
      }
      if (file.entries.some((entry) => entry.id === attempt.id)) throw new Error(`Duplicate knowledge ID: ${attempt.id}`);
      file.entries.push(attempt);
      file.audit ??= [];
      file.audit.push(auditEvent("add", "project", attempt, attempt));
      if (candidate) {
        if (attempt.simulated || !attempt.passed || !attempt.sourceRunId || candidate.sourceRunId !== attempt.sourceRunId ||
            candidate.evidence.length !== 1 || candidate.evidence[0].attemptId !== attempt.id ||
            candidate.evidence[0].runId !== attempt.sourceRunId || candidate.evidence[0].taskId !== attempt.taskId) {
          throw new Error("Candidate evidence must identify a validated live attempt");
        }
        const existing = file.entries.find((entry): entry is CandidateEntry => entry.kind === "candidate" && entry.fingerprint === candidate.fingerprint);
        if (existing) {
          existing.evidence.push(candidate.evidence[0]);
          existing.updatedAt = candidate.updatedAt;
          file.audit.push(auditEvent("observe", "project", existing, existing));
        } else {
          if (file.entries.some((entry) => entry.id === candidate.id)) throw new Error(`Duplicate knowledge ID: ${candidate.id}`);
          file.entries.push(candidate);
          file.audit.push(auditEvent("add", "project", candidate, candidate));
        }
      }
      await this.save("project", file);
    });
  }

  async reviewCandidate(id: string, status: ReviewStatus, now: string): Promise<CandidateEntry> {
    return this.locked("project", async () => {
      const { file } = await this.load("project");
      const candidate = file.entries.find((entry): entry is CandidateEntry => entry.kind === "candidate" && entry.id === id);
      if (!candidate) throw new Error(`Unknown candidate: ${id}`);
      if (candidate.lessonId && status !== "approved") throw new Error("An approved candidate already has a lesson; edit or remove that lesson separately");
      const before = { ...candidate, evidence: [...candidate.evidence] };
      if (status === "approved" && !candidate.lessonId) {
        const note: NoteEntry = { kind: "note", id: randomUUID(), scope: "project", sourceProject: candidate.sourceProject,
          sourceRunId: candidate.sourceRunId, text: candidate.text, taskCategory: candidate.taskCategory,
          createdAt: now, updatedAt: now, reviewStatus: "approved" };
        candidate.lessonId = note.id;
        file.entries.push(note);
        (file.audit ??= []).push(auditEvent("add", "project", note, note));
      }
      candidate.reviewStatus = status;
      candidate.updatedAt = now;
      (file.audit ??= []).push(auditEvent("review", "project", before, candidate));
      await this.save("project", file);
      return candidate;
    });
  }

  async change(scope: KnowledgeScope, id: string, action: KnowledgeAudit["action"], transform: (entry: KnowledgeEntry) => KnowledgeEntry | null): Promise<KnowledgeEntry | null> {
    return this.locked(scope, async () => {
      const { file } = await this.load(scope);
      const index = file.entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`Unknown knowledge ID: ${id}`);
      const before = file.entries[index];
      const after = transform(before);
      if (after === null) file.entries.splice(index, 1);
      else {
        if (after.id !== id || after.scope !== scope || after.kind !== before.kind) throw new Error("Knowledge identity cannot change");
        if (scope === "global" && JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Edit the project note, review it, and promote a new global lesson");
        file.entries[index] = after;
      }
      (file.audit ??= []).push(auditEvent(action, scope, before, after));
      await this.save(scope, file);
      return after;
    });
  }

  async audit(scope: KnowledgeScope): Promise<KnowledgeAudit[]> {
    return this.locked(scope, async () => {
      const { file, changed } = await this.load(scope);
      if (changed) await this.save(scope, file);
      return file.audit ?? [];
    });
  }
}

export class KnowledgeStore {
  readonly storage: KnowledgeStorage;

  constructor(readonly project: string, readonly home = process.env.ORCH_HOME ?? join(homedir(), ".orch"), storage?: KnowledgeStorage) {
    this.storage = storage ?? new LocalKnowledgeStorage(project, home);
  }

  path(scope: KnowledgeScope): string {
    return (this.storage instanceof LocalKnowledgeStorage ? this.storage : new LocalKnowledgeStorage(this.project, this.home)).path(scope);
  }

  async append(scope: KnowledgeScope, entry: KnowledgeEntry): Promise<void> {
    await this.storage.append(scope, entry);
  }

  async note(scope: KnowledgeScope, text: string, taskCategory: TaskType = "other", sourceRunId: string | null = null): Promise<NoteEntry> {
    if (scope !== "project") throw new Error("Add a project note, review it, then promote it to global knowledge");
    if (!text.trim()) throw new Error("Knowledge note cannot be empty");
    const now = new Date().toISOString();
    const entry: NoteEntry = {
      kind: "note", id: randomUUID(), scope, sourceProject: projectId(this.project), sourceRunId,
      text: text.trim(), taskCategory, createdAt: now, updatedAt: now, reviewStatus: "pending",
    };
    await this.append(scope, entry);
    return entry;
  }

  async recordAttempt(scope: KnowledgeScope, task: TaskSpec, attempt: AttemptRecord, simulated: boolean, sourceRunId: string | null = null): Promise<void> {
    if (scope !== "project") throw new Error("Attempt details and failures stay in project knowledge");
    const now = new Date().toISOString();
    const entry: AttemptEntry = {
      kind: "attempt", id: randomUUID(), scope, sourceProject: projectId(this.project), sourceRunId,
      at: now, taskId: task.id, attemptNumber: attempt.attempt,
      taskType: task.type, difficulty: task.difficulty, risk: task.risk,
      route: attempt.route.label, model: attempt.model,
      passed: attempt.validation.passed, errors: attempt.validation.errors,
      inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, simulated,
      latencyMs: attempt.latencyMs, checkCommand: attempt.checkCommand,
    };
    // Only a validated live success with a run ID can back a reviewable candidate.
    const candidate: CandidateEntry | null = !simulated && entry.passed && sourceRunId ? {
      kind: "candidate", id: randomUUID(), scope: "project", sourceProject: entry.sourceProject, sourceRunId,
      fingerprint: digest(JSON.stringify([task.type, task.difficulty, task.risk, entry.route, entry.model ?? null])),
      text: `For ${task.type} tasks (${task.difficulty} difficulty, ${task.risk} risk), ${entry.model ?? entry.route} passed validation on ${entry.route}. Review whether this route is useful for similar tasks.`,
      taskCategory: task.type, createdAt: now, updatedAt: now, reviewStatus: "pending",
      evidence: [{ attemptId: entry.id, runId: sourceRunId, taskId: task.id }],
    } : null;
    await this.storage.recordOutcome(entry, candidate);
  }

  async list(scope: KnowledgeScope): Promise<KnowledgeEntry[]> {
    return this.storage.list(scope);
  }

  async retrieve(task: TaskSpec, limit = MAX_RETRIEVED_LESSONS): Promise<SelectedLesson[]> {
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Knowledge retrieval limit must be a nonnegative integer");
    if (limit === 0) return [];
    const [projectEntries, globalEntries] = await Promise.all([this.list("project"), this.list("global")]);
    const taskTerms = retrievalTerms(task.description);
    const candidates = [...projectEntries, ...globalEntries]
      .filter((entry): entry is NoteEntry => entry.kind === "note" && entry.reviewStatus === "approved" &&
        (entry.scope === "project" || Boolean(entry.sourceEntryId)) && Boolean(entry.text.trim()))
      .map((entry) => {
        const categoryMatch = entry.taskCategory === task.type;
        const sharedTerms = [...retrievalTerms(entry.text)].filter((term) => taskTerms.has(term)).sort();
        const risks = mentionedRisks(entry.text);
        const riskMatch = risks.has(task.risk);
        const riskConflict = risks.size > 0 && !riskMatch;
        const relevant = categoryMatch || sharedTerms.length >= 2 || (entry.taskCategory === "other" && sharedTerms.length > 0);
        const score = (categoryMatch ? 6 : 0) + sharedTerms.length * 2 + (riskMatch ? 2 : 0);
        const reasons = [
          ...(categoryMatch ? [`category ${task.type}`] : []),
          ...(sharedTerms.length ? [`task text: ${sharedTerms.slice(0, 5).join(", ")}`] : []),
          ...(riskMatch ? [`${task.risk} risk`] : []),
        ];
        return { entry, reason: reasons.join("; "), score, relevant: relevant && !riskConflict };
      })
      .filter((item) => item.relevant && item.score > 0)
      .sort((a, b) => b.score - a.score ||
        (a.entry.scope === "project" ? -1 : 1) - (b.entry.scope === "project" ? -1 : 1) ||
        b.entry.updatedAt.localeCompare(a.entry.updatedAt) || a.entry.id.localeCompare(b.entry.id));
    const seenTexts = new Set<string>();
    const selected: SelectedLesson[] = [];
    for (const item of candidates) {
      const key = item.entry.text.trim().toLowerCase();
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      selected.push({ entry: item.entry, reason: item.reason });
      if (selected.length >= Math.min(limit, MAX_RETRIEVED_LESSONS)) break;
    }
    return selected;
  }

  async review(id: string, status: ReviewStatus): Promise<NoteEntry | CandidateEntry> {
    if ((await this.list("project")).some((entry) => entry.id === id && entry.kind === "candidate")) {
      return this.storage.reviewCandidate(id, status, new Date().toISOString());
    }
    const entry = await this.storage.change("project", id, "review", (current) => {
      if (current.kind !== "note") throw new Error("Only project notes can be reviewed");
      return { ...current, reviewStatus: status, updatedAt: new Date().toISOString() };
    });
    return entry as NoteEntry;
  }

  async edit(id: string, text: string): Promise<NoteEntry | CandidateEntry> {
    if (!text.trim()) throw new Error("Knowledge note cannot be empty");
    const entry = await this.storage.change("project", id, "edit", (current) => {
      if (current.kind === "attempt") throw new Error("Only project notes and candidates can be edited");
      if (current.kind === "candidate" && current.lessonId) throw new Error("Edit the approved lesson separately");
      return { ...current, text: text.trim(), reviewStatus: "pending", updatedAt: new Date().toISOString() };
    });
    return entry as NoteEntry | CandidateEntry;
  }

  async promote(id: string): Promise<NoteEntry> {
    const source = (await this.list("project")).find((entry) => entry.id === id);
    if (!source || source.kind !== "note") throw new Error(`Unknown project note: ${id}`);
    if (source.reviewStatus !== "approved") throw new Error("Review and approve the note before promotion");
    assertReusable(source.text);
    const existing = (await this.list("global")).find((entry) => entry.sourceEntryId === id);
    if (existing) throw new Error(`Note already promoted as ${existing.id}`);
    const now = new Date().toISOString();
    const entry: NoteEntry = { kind: "note", id: randomUUID(), scope: "global", sourceProject: source.sourceProject,
      sourceRunId: source.sourceRunId, sourceEntryId: id, text: source.text, taskCategory: source.taskCategory,
      createdAt: now, updatedAt: now, reviewStatus: "approved" };
    await this.append("global", entry);
    await this.storage.change("project", id, "promote", (current) => current);
    return entry;
  }

  async remove(scope: KnowledgeScope, id: string): Promise<void> {
    await this.storage.change(scope, id, "remove", () => null);
  }

  async audit(scope: KnowledgeScope): Promise<KnowledgeAudit[]> {
    return this.storage.audit(scope);
  }

  async export(scope: KnowledgeScope): Promise<{ scope: KnowledgeScope; entries: KnowledgeEntry[]; audit: KnowledgeAudit[] }> {
    const entries = await this.list(scope);
    return { scope, entries: scope === "global" ? entries.filter((entry) => entry.kind === "note" && entry.reviewStatus === "approved" && entry.sourceEntryId) : entries,
      audit: await this.audit(scope) };
  }
}
