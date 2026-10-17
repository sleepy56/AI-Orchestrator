import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { CommandService, executionGate, unavailablePinnedContext, worktreeBaseGate } from "./command-service";
import { loadRegistry } from "./models";
import { resolveCodexLaunch } from "./providers";

const exec = promisify(execFile);

export async function executionPreflight(project: string, mode: "live" | "simulated" = "simulated", check?: string) {
  const directory = resolve(project);
  const state = await new CommandService(directory).readOnlyDetail();
  const git = async (...args: string[]) => (await exec("git", ["-c", `safe.directory=${directory.replace(/\\/g, "/")}`, "-C", directory, ...args],
    { timeout: 5000, windowsHide: true })).stdout.trim();
  let repository = false;
  let branch: string | undefined;
  let head: string | undefined;
  let dirty: boolean | undefined;
  try {
    repository = resolve(await git("rev-parse", "--show-toplevel")) === directory;
    if (repository) {
      branch = await git("branch", "--show-current");
      head = await git("rev-parse", "HEAD");
      dirty = Boolean(await git("status", "--porcelain"));
    }
  } catch { /* A registered project may not be a Git repository. */ }
  const documents = state.project.value.context?.documents ?? [];
  const base = state.worktreeBase ?? null;
  const contextCommit = base?.commit ?? head;
  const unavailable = contextCommit ? await unavailablePinnedContext(directory, contextCommit, documents) : documents;
  const registry = await loadRegistry(directory);
  const enabled = registry.models.filter((model) => model.enabled && model.provider === "codex" && model.model);
  let executable = false;
  if (enabled.length) {
    try { await resolveCodexLaunch(); executable = true; } catch { /* Report setup without exposing PATH. */ }
  }
  const verification = [...new Set(Object.values(state.checks).filter((record) => record.value.command).map((record) => record.value.command!))];
  if (check?.trim() && !verification.includes(check.trim())) verification.push(check.trim());
  const blockers: string[] = [];
  const approval = executionGate(state);
  const baseGate = worktreeBaseGate(state);
  const branchMoved = base ? await git("rev-parse", `refs/heads/${base.branch}`).catch(() => "") !== base.commit : false;
  if (approval) blockers.push(approval);
  if (mode === "live") {
    if (!repository) blockers.push("Project is not a Git repository");
    if (baseGate && baseGate !== approval) blockers.push(baseGate);
    if (branchMoved) blockers.push("Approved base branch has moved");
    if (unavailable.length) blockers.push(`Context unavailable at ${contextCommit}: ${unavailable.join(", ")}`);
    if (!enabled.length) blockers.push("No enabled executable Codex model is configured");
    else if (!executable) blockers.push("Codex CLI is unavailable on PATH");
    if (!check?.trim()) blockers.push("Live Codex runs require --check with a project validation command");
  }
  const nextAction = approval ? "Review and approve the current plan and checks"
    : mode === "simulated" ? "Run orch run"
      : !repository ? "Initialize a Git repository for this project"
        : unavailable.length ? "Track the listed context files, commit them, and approve that base"
          : baseGate || branchMoved ? "Approve a current worktree base with orch worktrees base <branch> <commit>"
            : !enabled.length || !executable ? "Configure an enabled Codex model and CLI"
              : !check?.trim() ? "Supply a verification command with --check"
                : "Run orch run --executor codex --check '<command>'";
  return { directory, git: { isRepository: repository, branch, head, dirty }, approvedBase: base,
    context: { documents, checkedCommit: contextCommit, unavailable },
    provider: { id: enabled.length ? "codex" : null, enabledModels: enabled.map((model) => model.alias), executable }, mode, verification, blockers, nextAction };
}
