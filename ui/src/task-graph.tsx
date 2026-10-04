import { useMemo, useRef, type KeyboardEvent } from "react";
import type { Attempt, Run, RunEvent, Task } from "./api";

const nodeWidth = 232;
const nodeHeight = 112;
const columnGap = 92;
const rowGap = 32;
const padding = 32;

interface PlacedTask { task: Task; x: number; y: number }

function layout(tasks: Task[]): { placed: PlacedTask[]; width: number; height: number } {
  const byId = new Map(tasks.map((task) => [task.spec.id, task]));
  const depths = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    const value = task?.spec.dependsOn.length ? 1 + Math.max(...task.spec.dependsOn.map(depth)) : 0;
    depths.set(id, value);
    return value;
  };
  for (const task of tasks) depth(task.spec.id);
  const levels: Task[][] = [];
  for (const task of tasks) (levels[depth(task.spec.id)] ??= []).push(task);
  const maxRows = Math.max(1, ...levels.map((level) => level.length));
  const placed: PlacedTask[] = levels.flatMap((level, column) => level.map((task, row) => ({
    task,
    x: padding + column * (nodeWidth + columnGap),
    y: padding + (row + (maxRows - level.length) / 2) * (nodeHeight + rowGap),
  })));
  return {
    placed,
    width: padding * 2 + levels.length * nodeWidth + Math.max(0, levels.length - 1) * columnGap,
    height: padding * 2 + maxRows * nodeHeight + (maxRows - 1) * rowGap,
  };
}

function failedAncestor(id: string, byId: Map<string, Task>, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const task = byId.get(id);
  return Boolean(task?.spec.dependsOn.some((dependency) =>
    byId.get(dependency)?.displayStatus === "failed" || failedAncestor(dependency, byId, seen)));
}

interface Props {
  tasks: Task[];
  events: RunEvent[];
  run?: Run;
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function TaskGraph({ tasks, events, run, selectedId, onSelect }: Props) {
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const graph: ReturnType<typeof layout> = useMemo(() => layout(tasks), [tasks]);
  const byId: Map<string, Task> = useMemo(() => new Map(tasks.map((task) => [task.spec.id, task])), [tasks]);
  const positions = new Map<string, PlacedTask>(graph.placed.map((node) => [node.task.spec.id, node]));
  const selected = byId.get(selectedId ?? "");
  const dependents = selected ? tasks.filter((task) => task.spec.dependsOn.includes(selected.spec.id)) : [];
  const taskEvents = selected ? events.filter((event) => event.taskId === selected.spec.id) : [];
  const transitions = taskEvents.filter((event) => event.type === "task.started" || event.type === "task.finished" || event.type === "attempt.finished");
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return;
    const current = positions.get(id);
    if (!current) return;
    let target: PlacedTask | undefined;
    if (key === "Home") target = graph.placed[0];
    else if (key === "End") target = graph.placed.at(-1);
    else {
      const horizontal = key === "ArrowLeft" || key === "ArrowRight";
      const forward = key === "ArrowRight" || key === "ArrowDown";
      const candidates = graph.placed.filter((node) => node.task.spec.id !== id && (forward ? (horizontal ? node.x > current.x : node.y > current.y) : (horizontal ? node.x < current.x : node.y < current.y)));
      candidates.sort((a, b) => {
        const distance = (node: PlacedTask) => horizontal ? Math.abs(node.x - current.x) * 2 + Math.abs(node.y - current.y) : Math.abs(node.y - current.y) * 2 + Math.abs(node.x - current.x);
        return distance(a) - distance(b);
      });
      target = candidates[0];
    }
    if (!target) return;
    event.preventDefault();
    nodeRefs.current.get(target.task.spec.id)?.focus();
    onSelect(target.task.spec.id);
  };

  return <section className="panel graph-section" aria-labelledby="graph-heading">
    <div className="panel-header"><div><div className="overline">PLAN</div><h2 id="graph-heading">Task dependency graph</h2></div><span className="panel-count">{tasks.length} tasks</span></div>
    {tasks.length > 0 && <p id="graph-keyboard-hint" className="keyboard-hint">Tab to a task, then use arrow keys to move through the graph. Home and End move to the first and last task. Enter opens details.</p>}
    {tasks.length ? <div className="graph-detail-grid">
      <div className="graph-scroll" role="region" aria-label="Task dependency graph, scroll to see all tasks" aria-describedby="graph-keyboard-hint" tabIndex={0}>
        <div className="graph-canvas" style={{ width: graph.width, height: graph.height }}>
          <svg className="graph-edges" width={graph.width} height={graph.height} aria-hidden="true">
            <defs><marker id="graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" /></marker><marker id="graph-arrow-failed" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" /></marker></defs>
            {graph.placed.flatMap(({ task, x, y }) => task.spec.dependsOn.map((dependency) => {
              const from = positions.get(dependency);
              if (!from) return null;
              const x1 = from.x + nodeWidth;
              const y1 = from.y + nodeHeight / 2;
              const x2 = x - 8;
              const y2 = y + nodeHeight / 2;
              const curve = Math.max(24, (x2 - x1) / 2);
              const blocked = task.displayStatus === "blocked" && (from.task.displayStatus === "failed" || failedAncestor(dependency, byId));
              return <path key={`${dependency}-${task.spec.id}`} className={blocked ? "graph-edge failed-edge" : "graph-edge"} d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`} markerEnd={blocked ? "url(#graph-arrow-failed)" : "url(#graph-arrow)"} />;
            }))}
          </svg>
          {graph.placed.map(({ task, x, y }) => <button
            key={task.spec.id}
            ref={(node) => { if (node) nodeRefs.current.set(task.spec.id, node); else nodeRefs.current.delete(task.spec.id); }}
            type="button"
            className={`graph-node ${task.displayStatus}${task.spec.id === selectedId ? " selected" : ""}${task.displayStatus === "blocked" && failedAncestor(task.spec.id, byId) ? " failed-descendant" : ""}`}
            style={{ left: x, top: y, width: nodeWidth, height: nodeHeight }}
            aria-pressed={task.spec.id === selectedId}
            aria-label={`${task.spec.id}: ${task.spec.description}. ${task.displayStatus}. ${task.spec.dependsOn.length ? `Depends on ${task.spec.dependsOn.join(", ")}` : "No dependencies"}`}
            onClick={() => onSelect(task.spec.id)}
            onKeyDown={(event) => moveFocus(event, task.spec.id)}
          ><span className="graph-node-top"><strong>{task.spec.id}</strong><span className={`status-pill ${task.displayStatus}`}>{task.displayStatus}</span></span><span className="graph-node-description">{task.spec.description}</span></button>)}
        </div>
      </div>
      <aside className="task-detail" aria-labelledby="task-detail-heading">
        {selected ? <>
          <div className="task-detail-head"><div><div className="overline">SELECTED TASK</div><h3 id="task-detail-heading">{selected.spec.id}</h3></div><span className={`status-pill ${selected.displayStatus}`}>{selected.displayStatus}</span></div>
          <p className="task-detail-description">{selected.spec.description}</p>
          <div className="task-meta"><span>{selected.spec.type}</span><span>{selected.spec.difficulty}</span><span>{selected.spec.risk} risk</span></div>
          {selected.failureReason && <p className="task-failure">{selected.failureReason}</p>}
          {selected.displayStatus === "blocked" && <p className="dependency-note">{failedAncestor(selected.spec.id, byId) ? "Blocked by a failed predecessor." : "Waiting for dependencies to complete."}</p>}
          <div className="task-detail-block"><h4>Dependencies</h4>{selected.spec.dependsOn.length ? <ul className="dependency-list">{selected.spec.dependsOn.map((id) => <li key={id}><button type="button" onClick={() => onSelect(id)}>{id}</button><span className={`status-pill ${byId.get(id)?.displayStatus ?? "pending"}`}>{byId.get(id)?.displayStatus ?? "unknown"}</span></li>)}</ul> : <p>None</p>}</div>
          <div className="task-detail-block"><h4>Unblocks</h4>{dependents.length ? <ul className="dependency-list">{dependents.map((task) => <li key={task.spec.id}><button type="button" onClick={() => onSelect(task.spec.id)}>{task.spec.id}</button><span className={`status-pill ${task.displayStatus}`}>{task.displayStatus}</span></li>)}</ul> : <p>No direct dependents</p>}</div>
          <div className="task-detail-block"><h4>Validation evidence</h4>{selected.attempts.length ? <ol className="attempt-list">{[...selected.attempts].reverse().map((attempt) => <AttemptEvidence key={attempt.attempt} attempt={attempt} event={taskEvents.find((event) => event.type === "attempt.finished" && typeof event.attempt === "object" && event.attempt.attempt === attempt.attempt)} run={run} />)}</ol> : <p>No completed attempts recorded.</p>}</div>
          <div className="task-detail-block"><h4>Status history <span>· selected run</span></h4>{transitions.length ? <ol className="task-history">{transitions.map((event) => <li key={event.sequence}><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time><span>{event.type === "task.started" ? "Started" : event.type === "task.finished" ? `Task ${event.status}` : typeof event.attempt === "object" ? `Attempt ${event.attempt.attempt}: ${event.attempt.validation.passed ? "passed" : "failed"}` : "Attempt finished"}</span></li>)}</ol> : <p>No status events for this task in the selected run.</p>}</div>
        </> : <div className="empty-state" id="task-detail-heading">Select a task to inspect its status and validation.</div>}
      </aside>
    </div> : <div className="empty-state">No tasks in this project yet.</div>}
  </section>;
}

function AttemptEvidence({ attempt, event, run }: { attempt: Attempt; event?: RunEvent; run?: Run }) {
  const mode = event ? ((event.simulated ?? (run?.mode === "simulated")) ? "Simulated run" : "Live run") : "Project task record · run type unavailable";
  return <li className="attempt-card">
    <div className="attempt-heading"><strong>Attempt {attempt.attempt}</strong><span className={`status-pill ${attempt.validation.passed ? "completed" : "failed"}`}>{attempt.validation.passed ? "passed" : "failed"}</span></div>
    <p className="attempt-source">{mode}{event ? ` · ${new Date(event.at).toLocaleString()}` : ""}</p>
    {(attempt.model || attempt.route?.label) && <p>{attempt.route?.label}{attempt.model ? ` · ${attempt.model}` : ""}</p>}
    {attempt.checkCommand && <div className="command"><span>COMMAND</span><code>{attempt.checkCommand}</code></div>}
    {attempt.validation.errors.length ? <ul className="errors">{attempt.validation.errors.map((error, index) => <li key={index}>{error}</li>)}</ul> : <p className="attempt-result">Recorded validation passed.</p>}
    {!attempt.checkCommand && <p className="attempt-source">No check command recorded.</p>}
  </li>;
}
