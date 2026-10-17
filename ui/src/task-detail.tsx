import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HistoryAttempt, KnowledgeData, Model, Run, RunEvent, Task, WorkflowData } from "./api";
import { formatLatency, formatTokens, realModelAttempts, summarize } from "./evidence";

type Tab = "result" | "checks" | "route" | "branch" | "knowledge";
const tabs: Array<[Tab, string]> = [["result", "Result"], ["checks", "Checks"], ["route", "Model or routing"], ["branch", "Branch"], ["knowledge", "Recorded knowledge"]];

interface Props {
  task: Task;
  run?: Run;
  events: RunEvent[];
  knowledge: KnowledgeData;
  models: Model[];
  attempts: HistoryAttempt[];
  workflow: WorkflowData;
  isLatest: boolean;
  trigger: HTMLButtonElement;
  onClose: () => void;
}

export function TaskDetail({ task, run, events, knowledge, models, attempts, workflow, isLatest, trigger, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("result");
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (shell) shell.inert = true;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]):not([tabindex='-1']), a[href], [tabindex='0']")];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (shell) shell.inert = false; trigger.isConnected && trigger.focus(); };
  }, [trigger]);

  const taskEvents = events.filter((event) => event.taskId === task.spec.id);
  const attempt = task.attempts.at(-1);
  const route = [...taskEvents].reverse().find((event) => event.type === "route.decided");
  const model = models.find((item) => item.alias === (route?.chosenAlias ?? attempt?.route?.label));
  const modelEvidence = isLatest && model ? summarize(realModelAttempts(attempts, model)) : undefined;
  const recorded = taskEvents.filter((event) => event.selections?.length).flatMap((event) => event.selections ?? []);
  const used = isLatest ? knowledge.usedInRuns.filter((item) => item.runId === run?.runId && item.taskId === task.spec.id).flatMap((item) => item.selections) : [];
  const selections = recorded.length ? recorded : used;
  const worker = isLatest ? workflow.worktrees.workers[task.spec.id] : undefined;
  const source = run ? `${run.mode === "simulated" ? "Simulated" : "Live"} historical run ${run.runId}` : "Current project task record · run type unavailable";

  return createPortal(<div className="task-drawer-layer">
    <button type="button" tabIndex={-1} className="task-drawer-backdrop" aria-label="Close task details backdrop" onClick={onClose} />
    <section ref={dialog} className="task-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" aria-describedby="drawer-source">
      <div className="task-drawer-head"><small>{task.spec.id}</small><button ref={close} type="button" aria-label="Close task details" onClick={onClose}>×</button></div>
      <span className={`status-pill ${task.displayStatus}`}>{task.displayStatus}</span>
      <h2 id="drawer-title">{task.spec.description}</h2><p id="drawer-source">{source}</p>
      <div className="task-drawer-tabs" role="tablist" aria-label="Task evidence">{tabs.map(([key, label]) => <button key={key} type="button" role="tab" id={`drawer-tab-${key}`} aria-controls="drawer-evidence" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.findIndex(([item]) => item === key);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        setTab(tabs[next][0]);
        dialog.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
      }}>{label}</button>)}</div>
      <div id="drawer-evidence" className="task-drawer-evidence" role="tabpanel" aria-labelledby={`drawer-tab-${tab}`} tabIndex={0}>
        {tab === "result" && <><h3>Result</h3>{attempt?.response ? <pre>{attempt.response}</pre> : <p>No worker output recorded for this task at this point.</p>}{task.failureReason && <p className="task-failure">{task.failureReason}</p>}</>}
        {tab === "checks" && <><h3>Checks</h3>{attempt ? <><p>{attempt.validation.passed ? "Recorded validation passed" : "Recorded validation failed"} · attempt {attempt.attempt}</p>{attempt.checkCommand ? <div className="command"><span>COMMAND</span><code>{attempt.checkCommand}</code></div> : <p>No check command recorded.</p>}{attempt.validation.errors.length > 0 && <ul className="errors">{attempt.validation.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}</> : <p>No validation result recorded at this point.</p>}</>}
        {tab === "route" && <><h3>Model or routing</h3>{route || attempt?.model || attempt?.route ? <><p>{route?.chosenAlias ?? attempt?.route?.label ?? "Route alias unknown"} · {route?.chosenModel ?? attempt?.model ?? "Model unknown"}</p><p>{route?.reason ?? "No routing reason recorded."}</p>{isLatest && <p>Current aggregate live model evidence: {modelEvidence ? `${modelEvidence.attempts} attempts · tokens ${formatTokens(modelEvidence)} · latency ${formatLatency(modelEvidence)}` : "Unknown"}</p>}</> : <p>No route decision recorded at this point.</p>}</>}
        {tab === "branch" && <><h3>Branch and worktree</h3>{worker ? <><p>Current local worktree record · {worker.branch}</p><p className="task-drawer-path">{worker.path}</p><a href="#worktree-review" onClick={(event) => { event.preventDefault(); onClose(); window.setTimeout(() => { const target = document.getElementById("worktree-review"); if (target) { target.tabIndex = -1; target.scrollIntoView(); target.focus({ preventScroll: true }); } }, 0); }}>View worktree review</a></> : <p>{isLatest ? "No worktree or branch recorded for this task. No file link is available." : "Worktree state at this historical event is unknown."}</p>}</>}
        {tab === "knowledge" && <><h3>Recorded knowledge</h3>{selections.length ? <ul>{selections.map((selection, index) => <li key={`${selection.id}-${index}`}><strong>{selection.id}</strong> · {selection.scope} · {selection.reason}</li>)}</ul> : <p>No knowledge selection recorded for this task at this point.</p>}<p>Current retrieval matches are separate from recorded run use.</p></>}
      </div>
    </section>
  </div>, document.body);
}
