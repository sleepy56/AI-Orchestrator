import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { CheckRecord, CheckResult, CommandService } from "./command-service";

export interface CheckReportRow { id: string; taskId?: string; criterion?: string; phase: string; source?: string; command?: string; procedure?: string; expected: string; revision: number; status: CheckResult["status"] | "unrun"; result?: CheckResult; history?: Array<{ revision: number; command?: string; procedure?: string; phase: string; timeoutSeconds: number; expected: string; results: CheckResult[] }> }
export interface CheckReport { rows: CheckReportRow[]; counts: Record<CheckReportRow["status"], number> }

export async function checkReport(service: CommandService, taskId?: string): Promise<CheckReport> {
  const state = await service.readOnlyDetail();
  const draft = state.plan.value.draft;
  const rows: CheckReportRow[] = Object.entries(state.checks).filter(([, record]) =>
    record.value.planRevision === undefined || record.value.planRevision === state.plan.revision).filter(([, record]) =>
    !taskId || record.value.taskId === taskId || record.value.phase === "baseline").map(([id, record]) => {
    const result = [...(record.results ?? [])].reverse().find((item) => item.checkRevision === record.revision);
    return { id, taskId: record.value.taskId, criterion: record.value.criterion, phase: record.value.phase, source: record.value.source,
      command: record.value.command, procedure: record.value.procedure, expected: record.value.expected, revision: record.revision,
      status: result?.status ?? "unrun", result,
      history: (record.history ?? [{ revision: record.revision, value: record.value }]).map((entry) => ({ revision: entry.revision,
        command: entry.value.command, procedure: entry.value.procedure, phase: entry.value.phase, timeoutSeconds: entry.value.timeoutSeconds,
        expected: entry.value.expected, results: (record.results ?? []).filter((item) => item.checkRevision === entry.revision) })) };
  });
  for (const task of draft?.status === "review" ? draft.tasks : []) {
    if (taskId && task.id !== taskId) continue;
    for (const criterion of task.acceptanceCriteria) {
      if (!rows.some((row) => row.taskId === task.id && row.criterion === criterion)) rows.push({ id: `missing:${task.id}:${criterion}`, taskId: task.id, criterion, phase: "task", expected: criterion, revision: state.plan.revision, status: "missing" });
    }
  }
  if (!taskId && !rows.some((row) => row.phase === "baseline")) rows.push({ id: "missing:baseline", phase: "baseline", expected: "A recorded project baseline check", revision: 0, status: "missing" });
  if (taskId && !(draft?.tasks.some((task) => task.id === taskId) || state.tasks.some((task) => task.spec.id === taskId))) throw new Error(`Unknown task: ${taskId}`);
  if (taskId && !rows.some((row) => row.taskId === taskId)) rows.push({ id: `missing:${taskId}`, taskId, phase: "task", expected: "A task-specific verification check", revision: state.plan.revision, status: "missing" });
  const counts = { pass: 0, fail: 0, skipped: 0, missing: 0, unrun: 0 };
  for (const row of rows) counts[row.status]++;
  return { rows, counts };
}

export async function prepareBaseline(service: CommandService): Promise<string[]> {
  const state = await service.detail();
  let scripts: Record<string, string> = {};
  try {
    const manifest = JSON.parse(await readFile(join(state.project.value.directory, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    scripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const names = ["test", "build", "lint", "typecheck"].filter((name) => scripts[name]);
  const ids: string[] = [];
  for (const name of names) {
    const existing = Object.entries(state.checks).find(([, record]) => record.value.phase === "baseline" && record.value.command === `npm run ${name}`);
    if (existing) { ids.push(existing[0]); continue; }
    const result = await service.execute({ version: 1, kind: "check.put", expectedRevision: await service.revision(),
      payload: { phase: "baseline", command: `npm run ${name}`, cwd: ".", timeoutSeconds: 600, expected: "exit 0", criterion: `Existing ${name} script` } });
    ids.push(result.subjectId);
  }
  return ids;
}

export async function runCheck(service: CommandService, id: string, workspace?: string): Promise<CheckResult> {
  const state = await service.detail();
  const record: CheckRecord | undefined = state.checks[id];
  if (!record) throw new Error(`Unknown check: ${id}`);
  if (!record.value.command) throw new Error("Review check needs a named human review, not execution");
  const root = await realpath(workspace ?? state.project.value.directory);
  const target = resolve(root, record.value.cwd);
  if (isAbsolute(record.value.cwd) || !(target === root || target.startsWith(root + sep))) throw new Error("Check cwd escapes the project");
  const started = Date.now();
  let status: CheckResult["status"];
  let output = "";
  let exitCode: number | null = null;
  let reason: string | undefined;
  try {
    const actual = await realpath(target);
    if (!(actual === root || actual.startsWith(root + sep)) || !(await stat(actual)).isDirectory()) throw new Error("Check cwd escapes the project");
    const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>((done) => {
      const child = spawn(record.value.command!, { cwd: actual, shell: true, windowsHide: true, detached: process.platform !== "win32" });
      let body = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
        else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
        else child.kill();
      }, record.value.timeoutSeconds * 1000);
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => { body = (body + chunk).slice(-8192); });
      }
      child.on("error", (error) => { body = (body + error.message).slice(-8192); });
      child.on("close", (code) => { clearTimeout(timer); done({ code, output: body.trim(), timedOut }); });
    });
    output = result.output; exitCode = result.code;
    const expectedExit = /\bexit\s+(\d+)\b/i.exec(record.value.expected);
    const expectedOutput = /output includes:\s*(.+)/i.exec(record.value.expected)?.[1]?.trim();
    status = !result.timedOut && exitCode === (expectedExit ? Number(expectedExit[1]) : 0) && (!expectedOutput || output.includes(expectedOutput)) ? "pass" : "fail";
    if (result.timedOut) reason = `Timed out after ${record.value.timeoutSeconds} seconds`;
  } catch (error) {
    status = "missing"; reason = error instanceof Error ? error.message : String(error);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await service.execute({ version: 1, kind: "check.result", expectedRevision: await service.revision(),
        payload: { id, checkRevision: record.revision, status, exitCode, durationMs: Date.now() - started, ...(output ? { output } : {}), ...(reason ? { reason } : {}) } });
      break;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Stale revision:") || attempt === 19) throw error;
    }
  }
  return (await service.detail()).checks[id].results.at(-1)!;
}

export async function runBaseline(service: CommandService): Promise<CheckReport> {
  const ids = await prepareBaseline(service);
  for (const id of ids) await runCheck(service, id);
  return checkReport(service);
}
