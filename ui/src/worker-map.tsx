import { useState } from "react";
import type { Attempt, Model, Run, RunEvent, Task } from "./api";

type WorkerStatus = "ready" | "running" | "completed" | "failed";

interface WorkerView {
  model: Model;
  status: WorkerStatus;
  taskId?: string;
  attemptNumber?: number;
  result?: Attempt;
  resultTaskId?: string;
  resultSource?: string;
  route?: RunEvent;
}

const statusIcon: Record<WorkerStatus, string> = { ready: "○", running: "◌", completed: "✓", failed: "!" };

function routeForAttempt(events: RunEvent[], event: RunEvent): RunEvent | undefined {
  const number = typeof event.attempt === "number" ? event.attempt : event.attempt?.attempt;
  return [...events].reverse().find((candidate) => candidate.type === "route.decided" && candidate.taskId === event.taskId && candidate.attempt === number);
}

function matches(model: Model, route?: RunEvent): boolean {
  return route?.chosenAlias === model.alias || (!route?.chosenAlias && route?.route?.label === model.tier && route?.chosenModel === `${model.provider}:${model.model}`);
}

function workers(models: Model[], tasks: Task[], events: RunEvent[], run?: Run): WorkerView[] {
  return models.filter((model) => model.enabled).map((model) => {
    const route = [...events].reverse().find((event) => event.type === "route.decided" && matches(model, event));
    const active = [...events].reverse().find((event) => {
      if (event.type !== "attempt.started" || !matches(model, routeForAttempt(events, event))) return false;
      return !events.some((later) => later.sequence > event.sequence && later.taskId === event.taskId &&
        (later.type === "attempt.finished" && typeof later.attempt === "object" && later.attempt.attempt === event.attempt || later.type === "task.finished"));
    });
    const resultEvent = [...events].reverse().find((event) => event.type === "attempt.finished" && typeof event.attempt === "object" && matches(model, routeForAttempt(events, event)));
    const recorded = (run ? [] : [...tasks].flatMap((task) => task.attempts.map((attempt) => ({ taskId: task.spec.id, attempt }))))
      .filter(({ attempt }) => attempt.route?.label === model.tier && attempt.model === `${model.provider}:${model.model}`).at(-1);
    const result = typeof resultEvent?.attempt === "object" ? resultEvent.attempt : recorded?.attempt;
    const resultTaskId = resultEvent?.taskId ?? recorded?.taskId;
    const status: WorkerStatus = active ? "running" : resultEvent ? result?.validation.passed ? "completed" : "failed" : "ready";
    return {
      model, status,
      taskId: active?.taskId,
      attemptNumber: typeof active?.attempt === "number" ? active.attempt : undefined,
      result, resultTaskId, route,
      resultSource: resultEvent ? (resultEvent.simulated || run?.mode === "simulated" ? "Simulated run" : "Live run") : recorded ? "Project task record · run type unavailable" : undefined,
    };
  });
}

interface Props { models: Model[]; tasks: Task[]; events: RunEvent[]; run?: Run }

export function WorkerMap({ models, tasks, events, run }: Props) {
  const [selectedAlias, setSelectedAlias] = useState<string>();
  const [previewAlias, setPreviewAlias] = useState<string>();
  const views = workers(models, tasks, events, run);
  const selected = views.find((view) => view.model.alias === (previewAlias ?? selectedAlias)) ?? views[0];
  const canvasWidth = Math.max(740, views.length * 244 + 24);
  const activeCount = views.filter((view) => view.status === "running").length;

  return <section className="panel worker-section" aria-labelledby="worker-heading">
    <div className="panel-header"><div><div className="overline">EXECUTION</div><h2 id="worker-heading">Orchestrator and worker map</h2></div><span className="panel-count">{views.length} available workers</span></div>
    {views.length > 0 && <p id="worker-keyboard-hint" className="keyboard-hint">Tab to a worker, then use Left and Right arrows to preview workers. Enter keeps the selected worker open.</p>}
    {views.length ? <div className="worker-detail-grid">
      <div className="worker-scroll" role="region" aria-label="Orchestrator and worker map, scroll to see all workers" aria-describedby="worker-keyboard-hint" tabIndex={0}>
        <div className="worker-canvas" style={{ width: canvasWidth }}>
          <div className="orchestrator-node"><span className="orchestrator-symbol" aria-hidden="true">◎</span><div><strong>Orchestrator</strong><span>{run?.status === "running" ? "Routing run" : "Ready for a run"} · {activeCount} active</span></div></div>
          <svg className="worker-lines" viewBox={`0 0 ${canvasWidth} 68`} preserveAspectRatio="none" aria-hidden="true">
            {views.map((view, index) => {
              const end = (index + .5) * canvasWidth / views.length;
              return <path key={view.model.alias} className={view.status === "running" ? "worker-line active" : "worker-line"} d={`M ${canvasWidth / 2} 0 C ${canvasWidth / 2} 42, ${end} 26, ${end} 68`} />;
            })}
          </svg>
          <div className="worker-cards" style={{ gridTemplateColumns: `repeat(${views.length}, minmax(0, 1fr))` }}>
            {views.map((view) => <button key={view.model.alias} type="button" className={`worker-card ${view.status}${selected?.model.alias === view.model.alias ? " selected" : ""}`}
              aria-pressed={selectedAlias === view.model.alias} aria-label={`${view.model.alias}, ${view.model.provider}:${view.model.model}, ${view.status}${view.taskId ? `, ${view.taskId}, attempt ${view.attemptNumber}` : ""}`}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const index = views.findIndex((item) => item.model.alias === view.model.alias);
                const next = views[index + (event.key === "ArrowRight" ? 1 : -1)];
                if (!next) return;
                event.preventDefault();
                const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button.worker-card");
                buttons?.[index + (event.key === "ArrowRight" ? 1 : -1)]?.focus();
                setSelectedAlias(next.model.alias);
              }}
              onClick={() => setSelectedAlias(view.model.alias)} onFocus={() => setPreviewAlias(view.model.alias)} onBlur={() => setPreviewAlias(undefined)} onMouseEnter={() => setPreviewAlias(view.model.alias)} onMouseLeave={() => setPreviewAlias(undefined)}>
              <span className="worker-card-top"><strong>{view.model.alias}</strong><span className={`status-pill ${view.status}`}>{statusIcon[view.status]} {view.status}</span></span>
              <span className="worker-model">{view.model.provider}:{view.model.model}</span>
              <span className="worker-card-meta">{view.taskId ? `${view.taskId} · attempt ${view.attemptNumber}` : "No task assigned"}</span>
              <span className="worker-last">Last result: {view.result ? `${view.result.validation.passed ? "passed" : "failed"} · ${view.resultTaskId}` : "none recorded"}</span>
            </button>)}
          </div>
        </div>
      </div>
      {selected && <aside className="worker-detail" aria-live="polite" aria-label="Worker details">
        <div className="task-detail-head"><div><div className="overline">WORKER DETAILS</div><h3>{selected.model.alias}</h3></div><span className={`status-pill ${selected.status}`}>{statusIcon[selected.status]} {selected.status}</span></div>
        <dl className="worker-facts"><div><dt>Provider</dt><dd>{selected.model.provider}</dd></div><div><dt>Model ID</dt><dd>{selected.model.model}</dd></div><div><dt>Effort</dt><dd>{selected.model.effort}</dd></div><div><dt>Current task</dt><dd>{selected.taskId ? `${selected.taskId} · attempt ${selected.attemptNumber}` : "None"}</dd></div></dl>
        {selected.route && <div className="task-detail-block"><h4>Latest route in selected run</h4><p>{selected.route.taskId} · {selected.route.reason ?? "No reason recorded."}</p>{selected.route.policyVersion && <p>Policy version {selected.route.policyVersion}</p>}</div>}
        <div className="task-detail-block"><h4>Last result</h4>{selected.result ? <><p>{selected.resultTaskId} · attempt {selected.result.attempt} · {selected.result.validation.passed ? "Validation passed" : "Validation failed"}</p><p className="attempt-source">{selected.resultSource}</p>{selected.result.checkCommand && <div className="command"><span>COMMAND</span><code>{selected.result.checkCommand}</code></div>}{selected.result.validation.errors.length > 0 && <ul className="errors">{selected.result.validation.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}</> : <p>No completed attempt recorded for this worker.</p>}</div>
        <div className="task-detail-block"><h4>Worker response</h4>{selected.result?.response ? <pre className="worker-response">{selected.result.response}</pre> : <p>{selected.result ? "Response was not recorded for this attempt." : "No response yet."}</p>}</div>
      </aside>}
    </div> : <div className="empty-state">No enabled workers are configured.</div>}
  </section>;
}
