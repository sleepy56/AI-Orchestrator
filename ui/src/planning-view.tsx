import { useEffect, useState } from "react";
import { applyLocalCommand, checkAction, loadChecks, loadPlanning, requestPlanning, type CheckReport, type PlanningState } from "./api";

export function PlanningView({ initialState }: { initialState?: PlanningState } = {}) {
  const [state, setState] = useState<PlanningState | undefined>(initialState);
  const [goal, setGoal] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tasksText, setTasksText] = useState(JSON.stringify(initialState?.plan.value.draft?.tasks ?? [], null, 2));
  const [busy, setBusy] = useState(false);
  const [planningAction, setPlanningAction] = useState<"start" | "answer" | null>(null);
  const [planningSeconds, setPlanningSeconds] = useState(0);
  const [error, setError] = useState("");
  const [checks, setChecks] = useState<CheckReport>();
  const [checkTask, setCheckTask] = useState("");
  const [checkId, setCheckId] = useState("");
  const [checkCommand, setCheckCommand] = useState("");
  const [checkPhase, setCheckPhase] = useState("task");
  const [checkTimeout, setCheckTimeout] = useState(600);
  const [checkExpected, setCheckExpected] = useState("exit 0");
  const [checkCwd, setCheckCwd] = useState(".");
  const [checkCriterion, setCheckCriterion] = useState("");
  const [skipReason, setSkipReason] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [actionTarget, setActionTarget] = useState<"merge" | "deployment">("merge");
  const [destination, setDestination] = useState("");
  const [artifactRevision, setArtifactRevision] = useState("");
  const [baseRevision, setBaseRevision] = useState("");
  const refresh = async () => {
    const [next, checkReport] = await Promise.all([loadPlanning(), loadChecks()]);
    setState(next);
    setChecks(checkReport);
    setAnswers({});
    setTasksText(JSON.stringify(next.plan.value.draft?.tasks ?? [], null, 2));
  };
  useEffect(() => { void refresh().catch((cause) => setError(String(cause))); }, []);
  useEffect(() => {
    if (!planningAction) return;
    const timer = window.setInterval(() => setPlanningSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [planningAction]);
  const planAction = async (action: "start" | "answer", body: Record<string, unknown>) => {
    setPlanningSeconds(0);
    setPlanningAction(action);
    try { await act(() => requestPlanning(action, body)); }
    finally { setPlanningAction(null); }
  };
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const draft = state?.plan.value.draft;
  const staleAccessQuestion = draft?.status === "clarifying" && draft.questions.some((item) =>
    /(?:restore|grant|provide|fix|enable).{0,100}(?:read access|file access|workspace access|repository tree|document contents)|(?:read access|file access|workspace access).{0,100}(?:fail|denied|blocked)/i.test(`${item.question} ${item.impact}`));
  const approved = state && Object.values(state.approvals).some((record) => record.value.target === "plan" && record.value.targetRevision === state.plan.revision);
  const checksApproved = state && Object.values(state.approvals).some((record) => record.value.target === "checks" && record.value.targetRevision === state.checksRevision);
  return <div className="planning-view">
    <div className="page-intro"><div><div className="eyebrow">PLAN REVIEW</div><h1>AI planning draft</h1><p>Clarify the goal, inspect dependencies, and edit the draft before approval. Drafting starts no workers.</p></div></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <section className="panel"><div className="overline">01 · DEFINE</div><h2>Start from a goal</h2><label htmlFor="planning-goal">Development goal</label><textarea id="planning-goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} /><button type="button" disabled={busy || !goal.trim()} onClick={() => void planAction("start", { goal })}>{planningAction === "start" ? "Drafting…" : "Draft plan"}</button>{planningAction && <p role="status">Codex is inspecting the project and drafting {planningAction === "start" ? "a plan" : "the revised plan"} ({planningSeconds}s). This can take a few minutes. No workers are running.</p>}</section>
    {draft && <section className="panel"><div className="overline">02 · REVIEW</div><div className="panel-header"><h2>Revision {state?.plan.revision} · {draft.status === "clarifying" ? "Clarification" : approved ? "Approved" : "Review"}</h2></div><p><strong>Goal:</strong> {draft.goal}</p>
      {staleAccessQuestion ? <p role="alert">This saved question came from a project file access failure. It is not a product decision. Draft again after access is fixed.</p> : draft.status === "clarifying" ? <form onSubmit={(event) => { event.preventDefault(); if (state) void planAction("answer", { answers, expectedRevision: state.revision }); }}>
        {draft.questions.map((item) => <div className="planning-question" key={item.id}><label htmlFor={`answer-${item.id}`}>{item.question}</label><p>Why it matters: {item.impact}</p><textarea id={`answer-${item.id}`} required value={answers[item.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [item.id]: event.target.value })} rows={2} /></div>)}
        <button type="submit" disabled={busy}>{planningAction === "answer" ? "Drafting…" : "Answer and draft"}</button>
      </form> : <>
        <ol className="planning-tasks">{draft.tasks.map((task) => <li key={task.id}><h3>{task.id}: {task.description}</h3><p>{task.risk} risk · {task.difficulty} · {task.workerProfile} · depends on {task.dependsOn.join(", ") || "none"}</p><strong>Acceptance criteria</strong><ul>{task.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul><p><strong>Areas:</strong> {task.areas.join(", ")}</p><p><strong>Context:</strong> {task.context.join(", ")}</p><p><strong>Verification:</strong> {task.verification.join(", ")}</p>{task.testArtifacts?.map((artifact) => <details key={artifact.name}><summary>Generated test: .orch/generated-tests/plan-r{state?.plan.revision}/{task.id}/{artifact.name}</summary><pre>{artifact.content}</pre></details>)}</li>)}</ol>
        <label htmlFor="draft-json">Edit tasks JSON</label><textarea id="draft-json" className="planning-json" value={tasksText} onChange={(event) => setTasksText(event.target.value)} rows={16} spellCheck={false} />
        <div className="planning-actions"><button type="button" disabled={busy} onClick={() => void act(() => applyLocalCommand({ version: 1, kind: "plan.draft", expectedRevision: state!.revision, payload: { tasks: JSON.parse(tasksText) } }))}>Save revision</button><button type="button" disabled={busy || !!approved} onClick={() => void act(() => applyLocalCommand({ version: 1, kind: "approval.grant", expectedRevision: state!.revision, payload: { target: "plan", targetRevision: state!.plan.revision, actor: "user" } }))}>Approve revision</button></div>
      </>}
    </section>}
    <section className="panel" aria-label="Verification checks"><div className="overline">03 · VERIFY</div><h2>Verification checks</h2><p>Each acceptance criterion needs an executable check or named human review. Baseline failures show starting health and do not count as task regressions.</p>
      <p>Check set revision {state?.checksRevision ?? 0}: {checksApproved ? "Approved" : "Awaiting approval"}. Editing a check requires a new approval.</p>
      <button type="button" disabled={busy || !state?.checksRevision || !!checksApproved} onClick={() => void act(() => applyLocalCommand({ version: 1, kind: "approval.grant", expectedRevision: state!.revision, payload: { target: "checks", targetRevision: state!.checksRevision, actor: "user" } }))}>Approve checks revision</button>
      <button type="button" disabled={busy} onClick={() => void act(() => checkAction("baseline"))}>Run project baseline</button>
      <form onSubmit={(event) => { event.preventDefault(); if (state) void act(() => applyLocalCommand({ version: 1, kind: "check.put", expectedRevision: state.revision, payload: {
        ...(checkId.trim() ? { id: checkId.trim() } : {}), taskId: checkTask, phase: checkPhase, ...(checkPhase === "review" ? { procedure: checkCommand } : { command: checkCommand }), cwd: checkCwd,
        timeoutSeconds: checkTimeout, expected: checkExpected, ...(checkCriterion.trim() ? { criterion: checkCriterion } : {}),
      } })); }}>
        <h3>Add a task check</h3><label htmlFor="check-id">Check ID to revise (optional)</label><input id="check-id" value={checkId} onChange={(event) => setCheckId(event.target.value)} /><label htmlFor="check-task">Task ID</label><input id="check-task" required value={checkTask} onChange={(event) => setCheckTask(event.target.value)} placeholder="TASK-001" />
        <label htmlFor="check-criterion">Acceptance criterion</label><input id="check-criterion" value={checkCriterion} onChange={(event) => setCheckCriterion(event.target.value)} />
        <label htmlFor="check-phase">Phase</label><select id="check-phase" value={checkPhase} onChange={(event) => setCheckPhase(event.target.value)}><option value="task">Task</option><option value="integration">Integration</option><option value="review">Human review</option></select>
        <label htmlFor="check-command">{checkPhase === "review" ? "Review procedure" : "CLI command"}</label><textarea id="check-command" required value={checkCommand} onChange={(event) => setCheckCommand(event.target.value)} rows={2} />
        <label htmlFor="check-cwd">Working directory within project</label><input id="check-cwd" required value={checkCwd} onChange={(event) => setCheckCwd(event.target.value)} />
        <label htmlFor="check-timeout">Timeout (seconds)</label><input id="check-timeout" type="number" min={1} max={3600} value={checkTimeout} onChange={(event) => setCheckTimeout(Number(event.target.value))} />
        <label htmlFor="check-expected">Expected outcome</label><input id="check-expected" required value={checkExpected} onChange={(event) => setCheckExpected(event.target.value)} />
        <button type="submit" disabled={busy}>{checkId.trim() ? "Save check revision" : "Add check"}</button>
      </form>
      {checks && <><p role="status">Acceptance coverage: {checks.counts.missing ? `${checks.counts.missing} criterion${checks.counts.missing === 1 ? "" : "s"} without a check` : "all criteria have checks"}. {checks.counts.unrun} unrun · {checks.counts.fail} failed · {checks.counts.skipped} skipped · {checks.counts.pass} passed. {checksApproved ? "Current check revision approved." : "Review and approve this check revision before a live run."}</p>
        <ul className="check-list">{checks.rows.map((check) => <li key={check.id}><strong>{check.status.toUpperCase()}</strong> · {check.phase} · {check.taskId ?? "project"} · revision {check.revision}<p>{check.criterion ?? check.expected}</p><code>{check.command ?? check.procedure}</code><p>Expected: {check.expected}</p>{check.result?.reason && <p>Reason: {check.result.reason}</p>}{check.result?.reviewer && <p>Reviewer: {check.result.reviewer}</p>}
          {check.command && <button type="button" disabled={busy} onClick={() => void act(() => checkAction("run", check.id))}>Run check</button>}
          {check.source === "user" && check.taskId && <button type="button" disabled={busy} onClick={() => { setCheckId(check.id); setCheckTask(check.taskId ?? ""); setCheckCriterion(check.criterion ?? ""); setCheckPhase(check.phase); setCheckCommand(check.command ?? check.procedure ?? ""); setCheckExpected(check.expected); setCheckTimeout(check.history?.at(-1)?.timeoutSeconds ?? 600); }}>Revise check</button>}
          {!check.id.startsWith("missing:") && <><label htmlFor={`skip-${check.id}`}>Skip reason</label><input id={`skip-${check.id}`} value={skipReason} onChange={(event) => setSkipReason(event.target.value)} /><button type="button" disabled={busy || !skipReason.trim()} onClick={() => void act(() => applyLocalCommand({ version: 1, kind: "check.result", expectedRevision: state!.revision, payload: { id: check.id, checkRevision: check.revision, status: "skipped", reason: skipReason } }))}>Record skipped</button></>}
          {check.procedure && <><label htmlFor={`review-${check.id}`}>Reviewer</label><input id={`review-${check.id}`} value={reviewer} onChange={(event) => setReviewer(event.target.value)} /><button type="button" disabled={busy || !reviewer.trim()} onClick={() => void act(() => applyLocalCommand({ version: 1, kind: "check.result", expectedRevision: state!.revision, payload: { id: check.id, checkRevision: check.revision, status: "pass", reviewer } }))}>Record review</button></>}
          {check.history && <details><summary>Revision history ({check.history.length})</summary><ol>{check.history.map((entry) => <li key={entry.revision}>Revision {entry.revision}: {entry.phase}, timeout {entry.timeoutSeconds}s, expected {entry.expected}<br /><code>{entry.command ?? entry.procedure}</code><p>{entry.results.length ? entry.results.map((result) => `${result.status} at ${result.at}${result.reviewer ? ` by ${result.reviewer}` : ""}${result.reason ? `: ${result.reason}` : ""}`).join("; ") : "Unrun"}</p></li>)}</ol></details>}
        </li>)}</ul></>}
    </section>
    <section className="panel" aria-label="External action approvals"><div className="overline">04 · AUTHORIZE</div><h2>Merge and deployment approvals</h2><p>Each request names an exact artifact revision and destination. A merge also names the target branch head. Revised requests need fresh approval.</p>
      <form onSubmit={(event) => { event.preventDefault(); if (state) void act(() => applyLocalCommand({ version: 1, kind: "action.request", expectedRevision: state.revision, payload: {
        target: actionTarget, destination, artifactRevision, ...(actionTarget === "merge" ? { baseRevision } : {}),
      } })); }}>
        <label htmlFor="action-target">Action</label><select id="action-target" value={actionTarget} onChange={(event) => setActionTarget(event.target.value as "merge" | "deployment")}><option value="merge">Merge</option><option value="deployment">Deployment</option></select>
        <label htmlFor="action-destination">{actionTarget === "merge" ? "Target branch" : "Deployment destination"}</label><input id="action-destination" required value={destination} onChange={(event) => setDestination(event.target.value)} />
        <label htmlFor="artifact-revision">Integrated commit or artifact digest</label><input id="artifact-revision" required value={artifactRevision} onChange={(event) => setArtifactRevision(event.target.value)} />
        {actionTarget === "merge" && <><label htmlFor="base-revision">Target branch head</label><input id="base-revision" required value={baseRevision} onChange={(event) => setBaseRevision(event.target.value)} /></>}
        <button type="submit" disabled={busy || !state}>Request approval</button>
      </form>
      <ul>{Object.entries(state?.actions ?? {}).map(([id, action]) => {
        const stale = action.value.planRevision !== state?.plan.revision || action.value.checksRevision !== state?.checksRevision;
        const actionApproved = Object.values(state?.approvals ?? {}).some((record) => record.value.target === action.value.target && record.value.targetRevision === action.revision && record.value.actionId === id);
        return <li key={id}><strong>{action.value.target} revision {action.revision}</strong> · {action.value.destination} · {action.value.artifactRevision}<p>{stale ? "Plan or checks changed; create a new request" : !approved || !checksApproved ? "Approve current plan and checks first" : actionApproved ? "Approval recorded; target head is checked at resume" : "Paused for user approval"}</p><button type="button" disabled={busy || stale || !approved || !checksApproved || actionApproved} onClick={() => void act(() => applyLocalCommand({ version: 1, kind: "approval.grant", expectedRevision: state!.revision, payload: { target: action.value.target, actionId: id, targetRevision: action.revision, actor: "user" } }))}>Approve action</button></li>;
      })}</ul>
    </section>
    {Object.entries(state?.runs ?? {}).some(([, run]) => run.value.status === "paused") && <section className="panel" aria-label="Paused runs"><h2>Paused runs</h2><ul>{Object.entries(state?.runs ?? {}).filter(([, run]) => run.value.status === "paused").map(([id, run]) => <li key={id}><code>{id}</code> · {run.value.reason ?? "Approval pending"}. After approval, resume with <code>orch run --resume {id}</code>.</li>)}</ul></section>}
  </div>;
}
