import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadOverview, loadProject, type OverviewData, type ProjectData, type RunEvent, type Task } from "./api";
import { ProjectRegistration } from "./project-registration";
import { PlanningView } from "./planning-view";
import { TaskGraph } from "./task-graph";
import { TaskDetail } from "./task-detail";
import { WorkerMap } from "./worker-map";
import { LearningView, ModelsView } from "./models-learning";
import { KnowledgeView } from "./knowledge-view";
import { WorkflowView } from "./workflow-view";
import { StorageView } from "./storage-view";
import { replayRun } from "./replay";
import "./styles.css";

function shortDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function taskName(event: RunEvent, tasks: Task[]): string {
  return tasks.find((task) => task.spec.id === event.taskId)?.spec.description ?? event.taskId ?? "Run";
}

function eventLabel(event: RunEvent): string {
  switch (event.type) {
    case "run.started": return "Run started";
    case "run.resumed": return "Run resumed";
    case "run.paused": return "Run paused for approval";
    case "run.finished": return "Run finished";
    case "task.started": return "Task started";
    case "task.finished": return `Task ${event.status ?? "finished"}`;
    case "route.decided": return "Route chosen";
    case "attempt.started": return "Attempt started";
    case "attempt.finished": return typeof event.attempt === "object" && event.attempt.validation.passed ? "Validation passed" : "Validation failed";
    default: return event.type;
  }
}

function nextAction(data: OverviewData): { title: string; detail: string; href: "#planning" | "#workflow" } {
  const draft = data.planning.plan.value.draft;
  const approved = (target: string, revision: number) => Object.values(data.planning.approvals).some((record) => record.value.target === target && record.value.targetRevision === revision);
  if (!draft) return { title: "Describe a goal", detail: "Draft a plan before starting work.", href: "#planning" };
  if (draft.status === "clarifying") return { title: "Answer planning questions", detail: draft.questions[0]?.question ?? "The draft needs clarification.", href: "#planning" };
  if (!approved("plan", data.planning.plan.revision)) return { title: "Review the plan", detail: "Approve the current plan revision when it is ready.", href: "#planning" };
  if (!approved("checks", data.planning.checksRevision ?? 0)) return { title: "Review verification checks", detail: "Approve the current check set before a live run.", href: "#planning" };
  const paused = Object.entries(data.workflow.runs).find(([, run]) => run.value.status === "paused");
  if (paused) return { title: "Resume paused run", detail: paused[1].value.reason ?? `Run ${paused[0]} is paused.`, href: "#workflow" };
  if (data.tasks.some((task) => task.displayStatus === "running" || task.displayStatus === "possibly-interrupted")) return { title: data.workflow.runtime?.liveness === "active" ? "Inspect running work" : "Inspect possibly interrupted work", detail: "A task is recorded as running. Check its run and worker evidence before retrying.", href: "#workflow" };
  if (data.tasks.some((task) => task.displayStatus === "failed")) return { title: "Inspect failed task", detail: "Review its evidence before retrying.", href: "#workflow" };
  if (data.tasks.some((task) => task.displayStatus === "ready")) return { title: "Start ready work", detail: "A task is ready; choose simulated or live execution in Runs.", href: "#workflow" };
  if (data.tasks.length && data.tasks.every((task) => task.displayStatus === "completed")) return { title: "Review completed work", detail: "Inspect checks and integration evidence before any merge.", href: "#workflow" };
  return { title: "Inspect dependencies", detail: "No task is ready. Review the plan and task dependencies.", href: "#planning" };
}

function App() {
  const [view, setView] = useState<"overview" | "models" | "learning" | "knowledge" | "storage" | "project" | "planning" | "workflow">(() => viewFromHash());
  const [theme, setTheme] = useState<"light" | "dark">(() => window.localStorage.getItem("orch-theme") === "dark" ? "dark" : "light");
  const [data, setData] = useState<OverviewData>();
  const [projectData, setProjectData] = useState<ProjectData>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [taskDisplay, setTaskDisplay] = useState<"list" | "dependencies">("list");
  const [drawer, setDrawer] = useState<{ id: string; trigger: HTMLButtonElement }>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [replaySequence, setReplaySequence] = useState<number>();

  const refresh = useCallback(async (signal: AbortSignal) => {
    setRefreshing(true);
    try {
      const project = await loadProject(signal);
      if (signal.aborted) return;
      setProjectData(project);
      if (!project.registered) { setData(undefined); setView("project"); setError(undefined); return; }
      const next = await loadOverview(signal, selectedRunId);
      if (signal.aborted) return;
      setData(next);
      setError(undefined);
      setUpdatedAt(new Date());
    } catch (cause) {
      if (!signal.aborted) { setData(undefined); setProjectData(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("orch-theme", theme);
  }, [theme]);

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
  const currentTasks = data?.tasks ?? [];
  const blockedCount = currentTasks.filter((task) => task.displayStatus === "blocked").length;
  const action = data ? nextAction(data) : undefined;
  const chooseRun = (id: string) => { setDrawer(undefined); setSelectedRunId(id); setReplaySequence(undefined); setSelectedTaskId(undefined); setData(undefined); };
  const chooseSequence = (next: number) => {
    if (!selectedRunId && selectedRun) setSelectedRunId(selectedRun.runId);
    setReplaySequence(Math.max(1, Math.min(next, lastSequence)));
  };
  const projectDirectory = projectData && (projectData.registered ? projectData.project.value.directory : projectData.directory);
  const projectName = projectDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Connecting…";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to main content</a>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">◇</span><span>orch<span className="brand-dot">.</span></span></div>
        <a className="workspace-identity" href="#project" aria-label={`Active repository: ${projectName}. Project settings`}><span>ACTIVE REPOSITORY</span><strong title={projectDirectory}>{projectName}</strong><small title={projectDirectory}>{projectDirectory ?? "Waiting for local API"}</small></a>
        <div className="sidebar-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <a className={`nav-item ${view === "overview" ? "active" : ""}`} href="#overview" aria-current={view === "overview" ? "page" : undefined}><span aria-hidden="true">▦</span> Overview</a>
          <a className={`nav-item ${view === "planning" ? "active" : ""}`} href="#planning" aria-current={view === "planning" ? "page" : undefined}><span aria-hidden="true">◇</span> Plan</a>
          <a className={`nav-item ${view === "workflow" ? "active" : ""}`} href="#workflow" aria-current={view === "workflow" ? "page" : undefined}><span aria-hidden="true">◎</span> Runs</a>
          <a className={`nav-item ${view === "knowledge" ? "active" : ""}`} href="#knowledge" aria-current={view === "knowledge" ? "page" : undefined}><span aria-hidden="true">◇</span> Knowledge</a>
          <a className={`nav-item ${view === "storage" ? "active" : ""}`} href="#storage" aria-current={view === "storage" ? "page" : undefined}><span aria-hidden="true">▤</span> Storage</a>
        </nav>
        <details className="advanced-nav" open={view === "project" || view === "models" || view === "learning" ? true : undefined}><summary>Advanced</summary><nav aria-label="Advanced navigation">
          <a className={`nav-item ${view === "project" ? "active" : ""}`} href="#project" aria-current={view === "project" ? "page" : undefined}>Project</a>
          <a className={`nav-item ${view === "models" ? "active" : ""}`} href="#models" aria-current={view === "models" ? "page" : undefined}>Models</a>
          <a className={`nav-item ${view === "learning" ? "active" : ""}`} href="#learning" aria-current={view === "learning" ? "page" : undefined}>Learning</a>
        </nav></details>
        <div className="sidebar-bottom"><span className={`connection-dot ${error ? "offline" : !projectData ? "checking" : ""}`} aria-hidden="true" /> Local project {error ? "offline" : projectData ? "available" : "checking"} <span className="sidebar-version">v0.1</span></div>
      </aside>

      <main id="main-content" className="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="breadcrumb">{projectName} <span>/</span> <strong>{{ overview: "Overview", models: "Models", learning: "Learning", knowledge: "Knowledge", storage: "Storage", project: "Project", planning: "Plan", workflow: "Runs" }[view]}</strong></div>
          <div className="topbar-actions"><button type="button" aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`} aria-pressed={theme === "dark"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? "☾" : "☀"} <span>{theme === "light" ? "Dark" : "Light"}</span></button><button type="button" onClick={() => void refresh(new AbortController().signal)} disabled={refreshing}>↻ <span>Refresh</span></button></div>
        </header>

        <div className="content">
          {error && <div className="error-banner" role="alert"><strong>Could not load the local API.</strong> {error}. Start it with <code>npm run build</code> and <code>node dist/cli.js serve --port 8765</code>.</div>}
          {error && view === "overview" && <section className="panel"><h1>Overview unavailable</h1><p>Local project offline. Current goal, tasks, and activity cannot be confirmed.</p></section>}
          {!projectData && !error && <div className="loading" role="status">Loading project state…</div>}

          {projectData && view === "project" && <ProjectRegistration data={projectData} onRegistered={() => void refresh(new AbortController().signal)} />}
          {projectData && view === "storage" && <StorageView projectDirectory={projectDirectory ?? ""} />}
          {projectData?.registered && view === "planning" && <PlanningView />}
          {projectData?.registered && view === "workflow" && <WorkflowView />}

          {data && view === "models" && <ModelsView models={data.models} attempts={data.attempts} policyVersion={data.policyVersion} />}
          {data && view === "learning" && <LearningView models={data.models} attempts={data.attempts} policyVersion={data.policyVersion} />}
          {data && view === "knowledge" && <KnowledgeView knowledge={data.knowledge} proposals={data.proposals} tasks={data.tasks} onChanged={() => void refresh(new AbortController().signal)} />}
          {data && view === "overview" && <>
            <div className="page-intro"><div><div className="eyebrow">PROJECT CONTROL CENTER</div><h1>Overview</h1><p>Current project state from the local Orch API.</p></div><div className="update-time" aria-live="polite">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Connecting to local API"}</div></div>
            <section className="panel goal-card" aria-labelledby="goal-heading"><div className="overline">CURRENT GOAL · {projectName}</div><h2 id="goal-heading">{data.planning.plan.value.draft?.goal || "No goal recorded yet"}</h2><p>{data.planning.plan.value.draft ? `Plan revision ${data.planning.plan.revision} · ${data.planning.plan.value.draft.status === "clarifying" ? "Needs clarification" : Object.values(data.planning.approvals).some((record) => record.value.target === "plan" && record.value.targetRevision === data.planning.plan.revision) ? "Plan approved" : "Draft ready for review"}` : "Describe the work you want to plan."}</p><a href="#planning">Open Plan</a></section>
            <section className="panel next-action" aria-labelledby="next-action-heading"><div className="overline">NEXT DECISION OR ACTION</div><h2 id="next-action-heading">{action?.title}</h2><p>{action?.detail}</p><a href={action?.href}>Open {action?.href === "#planning" ? "Plan" : "Runs"}</a></section>
            <section className="metrics" aria-label="Current project status">
              <div className="metric"><div className="metric-label">TOTAL TASKS</div><div className="metric-value">{currentTasks.length.toString().padStart(2, "0")}</div><div className="metric-foot">Current project plan</div></div>
              <div className="metric"><div className="metric-label">IN PROGRESS</div><div className="metric-value cyan">{currentTasks.filter((task) => task.displayStatus === "running" || task.displayStatus === "possibly-interrupted").length.toString().padStart(2, "0")}</div><div className="metric-foot">Recorded task state</div></div>
              <div className="metric"><div className="metric-label">COMPLETED</div><div className="metric-value green">{currentTasks.filter((task) => task.displayStatus === "completed").length.toString().padStart(2, "0")}</div><div className="metric-foot">Completed task records</div></div>
              <div className="metric"><div className="metric-label">BLOCKED</div><div className="metric-value amber">{blockedCount.toString().padStart(2, "0")}</div><div className="metric-foot">Waiting on dependencies</div></div>
            </section>
            <div className="detail-grid lower-grid">
              <section className="panel" aria-labelledby="tasks-heading"><div className="panel-header"><div><div className="overline">CURRENT PLAN</div><h2 id="tasks-heading">Tasks</h2></div><a href="#workflow">View Runs</a></div>{currentTasks.length ? <ul className="overview-tasks">{currentTasks.map((task) => <li key={task.spec.id}><span><strong>{task.spec.id}</strong> {task.spec.description}</span><span className={`status-pill ${task.displayStatus}`}>{task.displayStatus}</span></li>)}</ul> : <div className="empty-state">No tasks in this project yet. Open Plan to draft work.</div>}</section>
              <section className="panel" aria-labelledby="activity-heading"><div className="panel-header"><div><div className="overline">LATEST RECORDED RUN</div><h2 id="activity-heading">Recent activity</h2></div><a href="#workflow">View Runs</a></div>{data.recentRun && <p className="activity-context">{data.recentRun.mode === "simulated" ? "Simulated run" : "Live run"} · {shortDate(data.recentRun.startedAt)} · {data.recentRun.status}</p>}{data.recentEvents.length ? <ol className="event-list">{[...data.recentEvents].reverse().slice(0, 5).map((event) => <li key={`${event.runId}-${event.sequence}`}><span className="event-indicator" aria-hidden="true" /><div><strong>{eventLabel(event)}</strong><p>{taskName(event, currentTasks)}</p></div><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ol> : <div className="empty-state">No run events recorded yet.</div>}</section>
            </div>
          </>}
          {data && view === "workflow" && <>
            <div className="page-intro"><div><div className="eyebrow">RUN HISTORY</div><h2>Run evidence</h2><p>Selected run and event below are historical records. Current project task state stays on Overview.</p></div></div>
            <section className="run-banner" aria-labelledby="run-heading">
              <div className="run-symbol" aria-hidden="true">◎</div>
              <div className="run-copy"><div className="overline">SELECTED HISTORICAL RUN</div><h2 id="run-heading">{run ? run.status === "running" ? "Run recorded as running" : run.status === "paused" ? "Run paused" : "Run finished" : "No runs yet"}</h2><p>{run ? `Started ${shortDate(run.startedAt)} · ${run.runId}` : "Plan tasks and start a run to see activity here."}</p></div>
              {run && <span className={`mode-badge ${run.mode}`}>{run.mode === "simulated" ? "◇ Simulated run" : "● Live run"}</span>}
            </section>

            <section className="panel runs-tasks" aria-labelledby="runs-tasks-heading">
              <div className="panel-header"><div><div className="overline">SELECTED HISTORICAL RUN</div><h2 id="runs-tasks-heading">Tasks</h2></div><div className="task-display" role="group" aria-label="Task display"><button type="button" aria-pressed={taskDisplay === "list"} onClick={() => setTaskDisplay("list")}>Task list</button><button type="button" aria-pressed={taskDisplay === "dependencies"} onClick={() => setTaskDisplay("dependencies")}>Dependencies</button></div></div>
              {taskDisplay === "list" && (tasks.length ? <ol className="runs-task-list">{tasks.map((task) => <li key={task.spec.id}><button type="button" onClick={(event) => { setSelectedTaskId(task.spec.id); setDrawer({ id: task.spec.id, trigger: event.currentTarget }); }}><span><strong>{task.spec.id} · {task.spec.description}</strong><small>{task.spec.dependsOn.length ? `Depends on ${task.spec.dependsOn.join(", ")}` : "No dependencies"}</small></span><span className={`status-pill ${task.displayStatus}`}>{task.displayStatus}</span><span aria-hidden="true">›</span></button></li>)}</ol> : <p className="empty-state">No tasks in this project yet.</p>)}
            </section>
            {taskDisplay === "dependencies" && <TaskGraph tasks={tasks} events={events} run={run} selectedId={graphSelectedId} onSelect={setSelectedTaskId} onOpen={(id, trigger) => setDrawer({ id, trigger })} />}

            <section className="panel timeline-panel" aria-labelledby="timeline-heading">
              <div className="panel-header"><div><div className="overline">RUN DETAIL</div><h2 id="timeline-heading">Timeline replay</h2></div>{run && <span className={`mode-badge ${run.mode}`}>{run.mode === "simulated" ? "◇ Simulated run" : "● Live run"}</span>}</div>
              {data.runs.length ? <>
                <label className="timeline-run-label">Run <select aria-label="Select run" value={selectedRun?.runId ?? ""} onChange={(event) => chooseRun(event.target.value)}>{data.runs.map((item) => <option key={item.runId} value={item.runId}>{shortDate(item.startedAt)} · {item.runId.slice(0, 8)} · {item.mode}</option>)}</select></label>
                {selectedRun && allEvents.length > 0 && <>
                  <div className="timeline-controls"><button type="button" onClick={() => chooseSequence(sequence - 1)} disabled={sequence <= 1} aria-label="Previous event">← Previous</button><label htmlFor="timeline-range">Event {sequence} of {lastSequence}<input id="timeline-range" type="range" min="1" max={lastSequence} value={sequence} onChange={(event) => chooseSequence(Number(event.target.value))} aria-valuetext={`Event ${sequence} of ${lastSequence}: ${selectedEvent ? eventLabel(selectedEvent) : "Run started"}`} /></label><button type="button" onClick={() => chooseSequence(sequence + 1)} disabled={isLatest} aria-label="Next event">Next →</button><button type="button" onClick={() => setReplaySequence(undefined)} disabled={isLatest}>Latest</button></div>
                  <p className="timeline-current" aria-live="polite"><strong>Historical run {selectedRun.runId} · event {sequence} of {lastSequence}</strong> · {selectedEvent ? eventLabel(selectedEvent) : "Run started"}{selectedEvent?.taskId ? ` · ${selectedEvent.taskId}` : ""} · {selectedEvent ? shortDate(selectedEvent.at) : ""}{isLatest ? " · Latest recorded event" : " · Selected historical time"}</p>
                  <ol className="timeline-events" aria-label="Run events">{allEvents.map((event) => <li key={event.sequence}><button type="button" aria-current={sequence === event.sequence ? "step" : undefined} className={sequence === event.sequence ? "selected" : ""} onClick={() => chooseSequence(event.sequence)}><span>#{event.sequence} {eventLabel(event)}</span><small>{event.taskId ?? new Date(event.at).toLocaleTimeString()}</small></button></li>)}</ol>
                </>}
              </> : <div className="empty-state">No run events recorded yet.</div>}
            </section>

            <div className="detail-grid">
              <section className="panel active-panel" aria-labelledby="active-heading"><div className="panel-header"><div><div className="overline">FOCUS</div><h2 id="active-heading">Active task</h2></div><span className={`status-pill ${activeTask?.displayStatus ?? "idle"}`}>{activeTask?.displayStatus ?? "idle"}</span></div>
                {activeTask ? <><div className="task-id">{activeTask.spec.id}</div><h3>{activeTask.spec.description}</h3><div className="task-meta"><span>{activeTask.spec.type}</span><span>{activeTask.spec.difficulty}</span><span>{activeTask.spec.risk} risk</span></div><div className="route-box"><div className="overline">LATEST ROUTE</div>{latestRoute ? <><strong>{latestRoute.chosenAlias ?? latestRoute.route?.label ?? "Route selected"}</strong><span>{latestRoute.chosenModel ?? routeModel?.model ?? "Model ID unavailable"}</span><p>{latestRoute.reason ?? "No routing reason recorded."}</p></> : <p>No route decision recorded for this task yet.</p>}</div></> : <div className="empty-state">No task is running. Ready tasks can be started from the CLI.</div>}
              </section>

              <section className="panel validation-panel" aria-labelledby="validation-heading"><div className="panel-header"><div><div className="overline">EVIDENCE</div><h2 id="validation-heading">Latest validation</h2></div>{validation && <span className={`status-pill ${validation.passed ? "completed" : "failed"}`}>{validation.passed ? "passed" : "failed"}</span>}</div>
                {validation ? <><div className="validation-mark" aria-hidden="true">{validation.passed ? "✓" : "!"}</div><div className="validation-title">{validation.passed ? "Checks passed" : "Checks need attention"}</div><p className="validation-task">{validationTask}</p>{checkCommand && <div className="command"><span>COMMAND</span><code>{checkCommand}</code></div>}{validation.errors.length > 0 && <ul className="errors">{validation.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}<p className="evidence-note">{latestValidation && run?.mode === "simulated" ? "Simulated run evidence" : latestValidation ? "Recorded run evidence" : "Latest task record"}</p></> : <div className="empty-state">No validation result recorded yet.</div>}
              </section>
            </div>

            <details className="runs-advanced"><summary>Advanced worker and routing view</summary><WorkerMap models={data.models} tasks={tasks} events={events} run={run} /></details>

          </>}
        </div>
      </main>
      {data && view === "workflow" && drawer && tasks.find((task) => task.spec.id === drawer.id) && <TaskDetail task={tasks.find((task) => task.spec.id === drawer.id)!} run={run} events={events} knowledge={data.knowledge} models={data.models} attempts={data.attempts} workflow={data.workflow} isLatest={isLatest} trigger={drawer.trigger} onClose={() => setDrawer(undefined)} />}
    </div>
  );
}

function viewFromHash(): "overview" | "models" | "learning" | "knowledge" | "storage" | "project" | "planning" | "workflow" {
  return window.location.hash === "#models" ? "models" : window.location.hash === "#learning" ? "learning" : window.location.hash === "#knowledge" ? "knowledge" : window.location.hash === "#storage" ? "storage" : window.location.hash === "#project" ? "project" : window.location.hash === "#planning" ? "planning" : window.location.hash === "#workflow" ? "workflow" : "overview";
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
