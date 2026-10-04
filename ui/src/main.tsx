import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadOverview, type OverviewData, type RunEvent, type Task, type TaskStatus } from "./api";
import { TaskGraph } from "./task-graph";
import { WorkerMap } from "./worker-map";
import { LearningView, ModelsView } from "./models-learning";
import { replayRun } from "./replay";
import "./styles.css";

const statusOrder: TaskStatus[] = ["running", "ready", "blocked", "failed", "completed", "pending"];

function shortDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function taskName(event: RunEvent, tasks: Task[]): string {
  return tasks.find((task) => task.spec.id === event.taskId)?.spec.description ?? event.taskId ?? "Run";
}

function eventLabel(event: RunEvent): string {
  switch (event.type) {
    case "run.started": return "Run started";
    case "run.finished": return "Run finished";
    case "task.started": return "Task started";
    case "task.finished": return `Task ${event.status ?? "finished"}`;
    case "route.decided": return "Route chosen";
    case "attempt.started": return "Attempt started";
    case "attempt.finished": return typeof event.attempt === "object" && event.attempt.validation.passed ? "Validation passed" : "Validation failed";
    default: return event.type;
  }
}

function App() {
  const [view, setView] = useState<"overview" | "models" | "learning">(() => viewFromHash());
  const [data, setData] = useState<OverviewData>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [replaySequence, setReplaySequence] = useState<number>();

  const refresh = useCallback(async (signal: AbortSignal) => {
    setRefreshing(true);
    try {
      const next = await loadOverview(signal, selectedRunId);
      if (signal.aborted) return;
      setData(next);
      setError(undefined);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal.aborted) setRefreshing(false);
    }
  }, [selectedRunId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), 5000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [refresh]);

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectedRun = data?.selectedRun;
  const allEvents = data?.events ?? [];
  const lastSequence = allEvents.at(-1)?.sequence ?? 0;
  const sequence = replaySequence === undefined ? lastSequence : Math.min(replaySequence, lastSequence);
  const frame = selectedRun && allEvents.length ? replayRun(selectedRun, allEvents, sequence) : undefined;
  const tasks = frame?.tasks ?? data?.tasks ?? [];
  const run = frame?.run;
  const events = frame?.events ?? [];
  const selectedEvent = events.at(-1);
  const isLatest = sequence === lastSequence;
  const currentTask = tasks.find((task) => task.displayStatus === "running") ??
    (run?.status === "running" ? [...events].reverse().find((event) => event.type === "task.started" && !events.some((later) => later.sequence > event.sequence && later.type === "task.finished" && later.taskId === event.taskId))?.taskId : undefined);
  const activeTask = typeof currentTask === "string" ? tasks.find((task) => task.spec.id === currentTask) : currentTask;
  const latestRoute = [...events].reverse().find((event) => event.type === "route.decided" && (!activeTask || event.taskId === activeTask.spec.id));
  const routeModel = data?.models.find((model) => model.alias === latestRoute?.chosenAlias);
  const latestValidation = [...events].reverse().find((event) => event.type === "attempt.finished" && typeof event.attempt === "object");
  const fallbackTask = run ? undefined : [...tasks].filter((task) => task.attempts.length).at(-1);
  const fallbackAttempt = fallbackTask?.attempts.at(-1);
  const eventAttempt = typeof latestValidation?.attempt === "object" ? latestValidation.attempt : undefined;
  const validation = eventAttempt?.validation ?? fallbackAttempt?.validation;
  const validationTask = latestValidation?.taskId ?? fallbackTask?.spec.id;
  const checkCommand = eventAttempt?.checkCommand ?? fallbackAttempt?.checkCommand;
  const graphSelectedId = tasks.some((task) => task.spec.id === selectedTaskId) ? selectedTaskId : activeTask?.spec.id ?? tasks[0]?.spec.id;
  const blockedCount = tasks.filter((task) => task.displayStatus === "blocked").length;
  const statusCounts = statusOrder.map((status) => ({ status, count: tasks.filter((task) => task.displayStatus === status).length })).filter((item) => item.count);
  const chooseRun = (id: string) => { setSelectedRunId(id); setReplaySequence(undefined); setSelectedTaskId(undefined); setData(undefined); };
  const chooseSequence = (next: number) => {
    if (!selectedRunId && selectedRun) setSelectedRunId(selectedRun.runId);
    setReplaySequence(Math.max(1, Math.min(next, lastSequence)));
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to main content</a>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">◇</span><span>orch<span className="brand-dot">.</span></span></div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <a className={`nav-item ${view === "overview" ? "active" : ""}`} href="#overview" aria-current={view === "overview" ? "page" : undefined}><span aria-hidden="true">▦</span> Overview</a>
          <a className={`nav-item ${view === "models" ? "active" : ""}`} href="#models" aria-current={view === "models" ? "page" : undefined}><span aria-hidden="true">◈</span> Models</a>
          <a className={`nav-item ${view === "learning" ? "active" : ""}`} href="#learning" aria-current={view === "learning" ? "page" : undefined}><span aria-hidden="true">↗</span> Learning</a>
        </nav>
        <div className="sidebar-bottom"><span className="connection-dot" aria-hidden="true" /> Local project <span className="sidebar-version">v0.1</span></div>
      </aside>

      <main id="main-content" className="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> <strong>{view === "overview" ? "Overview" : view === "models" ? "Models" : "Learning"}</strong></div>
          <div className="topbar-actions"><span className="read-only">READ ONLY</span><button type="button" onClick={() => void refresh(new AbortController().signal)} disabled={refreshing}>↻ <span>Refresh</span></button></div>
        </header>

        <div className="content">
          {error && <div className="error-banner" role="alert"><strong>Could not load the local API.</strong> {error}. Start it with <code>npm run build</code> and <code>node dist/cli.js serve --port 8765</code>.</div>}
          {!data && !error && <div className="loading" role="status">Loading project state…</div>}

          {data && view === "models" && <ModelsView models={data.models} attempts={data.attempts} policyVersion={data.policyVersion} />}
          {data && view === "learning" && <LearningView models={data.models} attempts={data.attempts} policyVersion={data.policyVersion} />}
          {data && view === "overview" && <>
            <div className="page-intro"><div><div className="eyebrow">PROJECT CONTROL CENTER</div><h1>Overview</h1><p>Live task state and validation evidence from your local Orch API.</p></div><div className="update-time" aria-live="polite">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Connecting to local API"}</div></div>
            <section className="run-banner" aria-labelledby="run-heading">
              <div className="run-symbol" aria-hidden="true">◎</div>
              <div className="run-copy"><div className="overline">SELECTED RUN</div><h2 id="run-heading">{run ? run.status === "running" ? "Run in progress" : "Run finished" : "No runs yet"}</h2><p>{run ? `Started ${shortDate(run.startedAt)} · ${run.runId.slice(0, 8)}` : "Plan tasks and start a run from the CLI to see activity here."}</p></div>
              {run && <span className={`mode-badge ${run.mode}`}>{run.mode === "simulated" ? "◇ Simulated run" : "● Live run"}</span>}
            </section>

            <section className="panel timeline-panel" aria-labelledby="timeline-heading">
              <div className="panel-header"><div><div className="overline">RUN DETAIL</div><h2 id="timeline-heading">Timeline replay</h2></div>{run && <span className={`mode-badge ${run.mode}`}>{run.mode === "simulated" ? "◇ Simulated run" : "● Live run"}</span>}</div>
              {data.runs.length ? <>
                <label className="timeline-run-label">Run <select aria-label="Select run" value={selectedRun?.runId ?? ""} onChange={(event) => chooseRun(event.target.value)}>{data.runs.map((item) => <option key={item.runId} value={item.runId}>{shortDate(item.startedAt)} · {item.runId.slice(0, 8)} · {item.mode}</option>)}</select></label>
                {selectedRun && allEvents.length > 0 && <>
                  <div className="timeline-controls"><button type="button" onClick={() => chooseSequence(sequence - 1)} disabled={sequence <= 1} aria-label="Previous event">← Previous</button><label htmlFor="timeline-range">Event {sequence} of {lastSequence}<input id="timeline-range" type="range" min="1" max={lastSequence} value={sequence} onChange={(event) => chooseSequence(Number(event.target.value))} aria-valuetext={`Event ${sequence} of ${lastSequence}: ${selectedEvent ? eventLabel(selectedEvent) : "Run started"}`} /></label><button type="button" onClick={() => chooseSequence(sequence + 1)} disabled={isLatest} aria-label="Next event">Next →</button><button type="button" onClick={() => setReplaySequence(undefined)} disabled={isLatest}>Latest</button></div>
                  <p className="timeline-current" aria-live="polite"><strong>{selectedEvent ? eventLabel(selectedEvent) : "Run started"}</strong>{selectedEvent?.taskId ? ` · ${selectedEvent.taskId}` : ""} · {selectedEvent ? shortDate(selectedEvent.at) : ""}{isLatest ? " · Latest event" : " · Historical state"}</p>
                  <ol className="timeline-events" aria-label="Run events">{allEvents.map((event) => <li key={event.sequence}><button type="button" aria-current={sequence === event.sequence ? "step" : undefined} className={sequence === event.sequence ? "selected" : ""} onClick={() => chooseSequence(event.sequence)}><span>#{event.sequence} {eventLabel(event)}</span><small>{event.taskId ?? new Date(event.at).toLocaleTimeString()}</small></button></li>)}</ol>
                </>}
              </> : <div className="empty-state">No run events recorded yet.</div>}
            </section>

            <section className="metrics" aria-label="Project status">
              <div className="metric"><div className="metric-label">TOTAL TASKS</div><div className="metric-value">{tasks.length.toString().padStart(2, "0")}</div><div className="metric-foot">In project plan</div></div>
              <div className="metric"><div className="metric-label">IN PROGRESS</div><div className="metric-value cyan">{tasks.filter((task) => task.displayStatus === "running").length.toString().padStart(2, "0")}</div><div className="metric-foot">Currently executing</div></div>
              <div className="metric"><div className="metric-label">COMPLETED</div><div className="metric-value green">{tasks.filter((task) => task.displayStatus === "completed").length.toString().padStart(2, "0")}</div><div className="metric-foot">Validated tasks</div></div>
              <div className="metric"><div className="metric-label">BLOCKED</div><div className="metric-value amber">{blockedCount.toString().padStart(2, "0")}</div><div className="metric-foot">Waiting on dependencies</div></div>
            </section>

            <div className="detail-grid">
              <section className="panel active-panel" aria-labelledby="active-heading"><div className="panel-header"><div><div className="overline">FOCUS</div><h2 id="active-heading">Active task</h2></div><span className={`status-pill ${activeTask?.displayStatus ?? "idle"}`}>{activeTask?.displayStatus ?? "idle"}</span></div>
                {activeTask ? <><div className="task-id">{activeTask.spec.id}</div><h3>{activeTask.spec.description}</h3><div className="task-meta"><span>{activeTask.spec.type}</span><span>{activeTask.spec.difficulty}</span><span>{activeTask.spec.risk} risk</span></div><div className="route-box"><div className="overline">LATEST ROUTE</div>{latestRoute ? <><strong>{latestRoute.chosenAlias ?? latestRoute.route?.label ?? "Route selected"}</strong><span>{latestRoute.chosenModel ?? routeModel?.model ?? "Model ID unavailable"}</span><p>{latestRoute.reason ?? "No routing reason recorded."}</p></> : <p>No route decision recorded for this task yet.</p>}</div></> : <div className="empty-state">No task is running. Ready tasks can be started from the CLI.</div>}
              </section>

              <section className="panel validation-panel" aria-labelledby="validation-heading"><div className="panel-header"><div><div className="overline">EVIDENCE</div><h2 id="validation-heading">Latest validation</h2></div>{validation && <span className={`status-pill ${validation.passed ? "completed" : "failed"}`}>{validation.passed ? "passed" : "failed"}</span>}</div>
                {validation ? <><div className="validation-mark" aria-hidden="true">{validation.passed ? "✓" : "!"}</div><div className="validation-title">{validation.passed ? "Checks passed" : "Checks need attention"}</div><p className="validation-task">{validationTask}</p>{checkCommand && <div className="command"><span>COMMAND</span><code>{checkCommand}</code></div>}{validation.errors.length > 0 && <ul className="errors">{validation.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}<p className="evidence-note">{latestValidation && run?.mode === "simulated" ? "Simulated run evidence" : latestValidation ? "Recorded run evidence" : "Latest task record"}</p></> : <div className="empty-state">No validation result recorded yet.</div>}
              </section>
            </div>

            <WorkerMap models={data.models} tasks={tasks} events={events} run={run} />
            <TaskGraph tasks={tasks} events={events} run={run} selectedId={graphSelectedId} onSelect={setSelectedTaskId} />

            <div className="detail-grid lower-grid">
              <section className="panel" aria-labelledby="tasks-heading"><div className="panel-header"><div><div className="overline">PLAN</div><h2 id="tasks-heading">Task status</h2></div><span className="panel-count">{tasks.length} tasks</span></div>{tasks.length ? <><div className="status-bar" aria-hidden="true">{statusCounts.map(({ status, count }) => <div key={status} className={`bar-${status}`} style={{ flex: count }} />)}</div><ul className="status-list">{statusCounts.map(({ status, count }) => <li key={status}><span><i className={`status-dot ${status}`} />{status}</span><strong>{count}</strong></li>)}</ul></> : <div className="empty-state">No tasks in this project yet.</div>}</section>
              <section className="panel" aria-labelledby="activity-heading"><div className="panel-header"><div><div className="overline">EVENT LOG</div><h2 id="activity-heading">Recent activity</h2></div><span className="panel-count">{events.length} events</span></div>{events.length ? <ol className="event-list">{[...events].reverse().slice(0, 5).map((event) => <li key={`${event.runId}-${event.sequence}`}><span className="event-indicator" aria-hidden="true" /><div><strong>{eventLabel(event)}</strong><p>{taskName(event, tasks)}</p></div><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ol> : <div className="empty-state">No run events recorded yet.</div>}</section>
            </div>
          </>}
        </div>
      </main>
    </div>
  );
}

function viewFromHash(): "overview" | "models" | "learning" {
  return window.location.hash === "#models" ? "models" : window.location.hash === "#learning" ? "learning" : "overview";
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
