import { useEffect, useState } from "react";
import { applyLocalCommand, loadWorkflow, workflowAction, type WorkflowData } from "./api";

export function WorkflowView({ initialState }: { initialState?: WorkflowData } = {}) {
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [branch, setBranch] = useState(initialState?.base?.branch ?? "");
  const [commit, setCommit] = useState(initialState?.base?.commit ?? "");
  const [mode, setMode] = useState<"fake" | "codex">("fake");
  const [once, setOnce] = useState(false);
  const [check, setCheck] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [taskIds, setTaskIds] = useState("");
  const [limits, setLimits] = useState(JSON.stringify(initialState?.policy.routing.limits ?? {}, null, 2));
  const [reason, setReason] = useState("");
  const [routeTask, setRouteTask] = useState("");
  const [retryTask, setRetryTask] = useState("");
  const refresh = async () => {
    const next = await loadWorkflow();
    setState(next);
    setLimits(JSON.stringify(next.policy.routing.limits, null, 2));
  };
  useEffect(() => {
    let active = true;
    void loadWorkflow().then((next) => { if (active) { setState(next); setLimits(JSON.stringify(next.policy.routing.limits, null, 2)); } },
      (cause) => { if (active) { setState(undefined); setError(String(cause)); } });
    const timer = window.setInterval(() => void loadWorkflow().then((next) => { if (active) { setState(next); setError(""); } },
      (cause) => { if (active) { setState(undefined); setError(String(cause)); } }), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(""); setResult("");
    try { const value = await action(); setResult(JSON.stringify(value, null, 2)); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const command = (kind: "worktree.base" | "plan.retry" | "policy.limits" | "policy.route" | "policy.rollback", payload: Record<string, unknown>) =>
    applyLocalCommand({ version: 1, kind, expectedRevision: state!.revision, payload });
  const paused = Object.entries(state?.runs ?? {}).filter(([, run]) => run.value.status === "paused");
  return <div className="workflow-view">
    <div className="page-intro"><div><div className="eyebrow">LOCAL EXECUTION</div><h1>Runs and routing</h1><p>Worktrees, capacity, and policy history from the local project service.</p></div></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {result && <details><summary>Latest operation result</summary><pre>{result}</pre></details>}
    {!state ? <p className="empty-state">Connecting to the local project service…</p> : <>
      <section className="panel"><h2>Provider capacity</h2><p>Availability: <strong>{state.capacity.availability}</strong>{state.capacity.signal?.remainingTokens !== undefined && state.capacity.availability === "known" ? ` · ${state.capacity.signal.remainingTokens.toLocaleString()} measured tokens` : " · remaining quota unknown"}</p>
        {state.capacity.signal && <p>Observed {state.capacity.signal.observedAt}{state.capacity.signal.maxConcurrent ? ` · up to ${state.capacity.signal.maxConcurrent} concurrent workers` : ""}{state.capacity.signal.resetAt ? ` · resets ${state.capacity.signal.resetAt}` : ""}{state.capacity.signal.retryAfter ? ` · retry after ${state.capacity.signal.retryAfter}` : ""}</p>}
        <button type="button" disabled={busy} onClick={() => void act(async () => loadWorkflow())}>Refresh capacity</button>
      </section>
      <section className="panel"><h2>Approved worktree base</h2><p>{state.base ? `${state.base.branch} · ${state.base.commit}` : "No pinned base yet"}</p>
        <form onSubmit={(event) => { event.preventDefault(); void act(() => command("worktree.base", { branch, commit, actor: "user" })); }}>
          <label htmlFor="base-branch">Target branch</label><input id="base-branch" required value={branch} onChange={(event) => setBranch(event.target.value)} />
          <label htmlFor="base-commit">Exact base commit</label><input id="base-commit" required value={commit} onChange={(event) => setCommit(event.target.value)} />
          <button type="submit" disabled={busy}>Pin worktree base</button>
        </form>
      </section>
      <section className="panel"><h2>Run tasks</h2><p>Live runs require approved plan and checks, a pinned base, and a validation command. Capacity pauses keep their run ID.</p>
        <label htmlFor="run-mode">Executor</label><select id="run-mode" value={mode} onChange={(event) => setMode(event.target.value as "fake" | "codex")}><option value="fake">Simulated</option><option value="codex">Live Codex worktrees</option></select>
        <label htmlFor="run-check">Validation command for live workers</label><input id="run-check" value={check} onChange={(event) => setCheck(event.target.value)} placeholder="npm test" />
        <label htmlFor="run-timeout">Worker timeout (seconds)</label><input id="run-timeout" type="number" min={1} max={3600} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} />
        <label><input type="checkbox" checked={once} onChange={(event) => setOnce(event.target.checked)} /> Start one ready task</label>
        <button type="button" disabled={busy || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 || (mode === "codex" && !check.trim())} onClick={() => void act(() => workflowAction({ operation: "run", mode, once, timeoutSeconds, ...(mode === "codex" ? { check } : {}) }))}>Start run</button>
        {paused.length > 0 && <><h3>Paused runs</h3><ul>{paused.map(([id, run]) => <li key={id}><code>{id}</code> · {run.value.reason ?? "Paused"} <button type="button" disabled={busy || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600 || (run.value.mode === "live" && !check.trim())} onClick={() => void act(() => workflowAction({ operation: "run", mode: run.value.mode === "live" ? "codex" : "fake", resume: id, timeoutSeconds, ...(run.value.mode === "live" ? { check } : {}) }))}>Resume run</button></li>)}</ul></>}
        <p>After an interrupted worker stops, inspect its worktree before retrying the task.</p><label htmlFor="retry-task">Task ID to retry</label><input id="retry-task" value={retryTask} onChange={(event) => setRetryTask(event.target.value)} /><button type="button" disabled={busy || !retryTask.trim()} onClick={() => void act(() => command("plan.retry", { taskId: retryTask }))}>Retry inspected task</button>
        {(state.jobs ?? []).length > 0 && <><h3>Local run requests</h3><ul>{[...state.jobs!].reverse().map((job) => <li key={job.id}><strong>{job.status}</strong> · {job.startedAt} · {job.id}<details><summary>CLI output</summary><pre>{job.output || "No output yet"}</pre>{job.errorOutput && <pre>{job.errorOutput}</pre>}</details></li>)}</ul></>}
      </section>
      <section className="panel"><h2>Worktree review</h2><ul>{Object.entries(state.worktrees.workers).map(([id, worker]) => <li key={id}><strong>{id}</strong> · {worker.branch} · {worker.validation?.passed ? "validated" : worker.validation ? "failed validation" : "pending validation"}{worker.commit && <p>Commit {worker.commit}</p>}<details><summary>Local worker details</summary><p>{worker.path}</p><pre>{worker.validation?.output ?? "No validation output"}</pre></details></li>)}</ul>
        <form onSubmit={(event) => { event.preventDefault(); void act(() => workflowAction({ operation: "integrate", taskIds: taskIds.split(",").map((id) => id.trim()).filter(Boolean), check })); }}><h3>Integrate validated tasks</h3><label htmlFor="integrate-ids">Task IDs, comma separated</label><input id="integrate-ids" required value={taskIds} onChange={(event) => setTaskIds(event.target.value)} /><label htmlFor="integrate-check">Integration check</label><input id="integrate-check" required value={check} onChange={(event) => setCheck(event.target.value)} /><button type="submit" disabled={busy}>Integrate and check</button></form>
        <h3>Integration records</h3><ul>{Object.entries(state.worktrees.integrations).map(([id, integration]) => <li key={id}><strong>{integration.taskIds.join(", ")}</strong> · {integration.target} · {integration.merged ? "merged" : integration.conflicts.length ? "conflicts" : integration.check?.passed ? "validated" : "needs validation"}<p>Base {integration.base} · commit {integration.commit ?? "none"} · approval {integration.actionId ?? "none"}</p><details><summary>Combined diff, conflicts, and check evidence</summary><p>{integration.path}</p><p>Conflicts: {integration.conflicts.join(", ") || "none"}</p><pre>{integration.diff}</pre><pre>{integration.check?.output}</pre></details>{!integration.check?.passed && !integration.merged && <button type="button" disabled={busy || !check.trim()} onClick={() => void act(() => workflowAction({ operation: "verify", integrationId: id, check }))}>Verify integration</button>}{integration.actionId && !integration.merged && <button type="button" disabled={busy} onClick={() => void act(() => workflowAction({ operation: "merge", actionId: integration.actionId }))}>Merge approved integration</button>}</li>)}</ul>
      </section>
      <section className="panel"><h2>Routing policy history</h2><p>Version {state.policy.version}. User limits take precedence over automatic route choices.</p><details><summary>Current rules and limits</summary><pre>{JSON.stringify(state.policy.routing, null, 2)}</pre></details>
        <form onSubmit={(event) => { event.preventDefault(); void act(async () => command("policy.limits", { limits: JSON.parse(limits), reason, actor: "user" })); }}><h3>Set user limits</h3><label htmlFor="policy-limits">Limits JSON</label><textarea id="policy-limits" value={limits} onChange={(event) => setLimits(event.target.value)} rows={5} /><label htmlFor="policy-reason">Reason</label><input id="policy-reason" required value={reason} onChange={(event) => setReason(event.target.value)} /><button type="submit" disabled={busy}>Save limits revision</button></form>
        <label htmlFor="route-task">Task ID for observed route proposal</label><input id="route-task" value={routeTask} onChange={(event) => setRouteTask(event.target.value)} /><button type="button" disabled={busy || !routeTask.trim()} onClick={() => void act(() => command("policy.route", { taskId: routeTask }))}>Apply validated route</button>
        <ol>{[...state.policy.history].reverse().map((entry) => <li key={entry.version}><strong>Version {entry.version}</strong> · {entry.author} · {entry.cause} · {entry.at}<p>{entry.reason}</p><p>Evidence: {entry.evidenceIds.length ? entry.evidenceIds.join(", ") : "none"}{entry.priceVersion ? ` · price ${entry.priceVersion} ${entry.currency ?? ""}` : ""}</p>{entry.baseline && entry.candidate && <p>Baseline {entry.baseline.alias}: {entry.baseline.validatedPasses}/{entry.baseline.taskCount} tasks, {entry.baseline.retries} retries, {entry.baseline.averageLatencyMs.toFixed(0)} ms, {entry.baseline.averageCostPerTask.toFixed(6)} cost. Candidate {entry.candidate.alias}: {entry.candidate.validatedPasses}/{entry.candidate.taskCount} tasks, {entry.candidate.retries} retries, {entry.candidate.averageLatencyMs.toFixed(0)} ms, {entry.candidate.averageCostPerTask.toFixed(6)} cost.</p>}<details><summary>Previous and new rules</summary><pre>{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</pre></details><button type="button" disabled={busy} onClick={() => void act(() => command("policy.rollback", { targetVersion: entry.rollbackTo, reason: `Restore route rules from version ${entry.rollbackTo}`, actor: "user" }))}>Restore route rules from version {entry.rollbackTo}</button></li>)}</ol>
      </section>
    </>}
  </div>;
}
