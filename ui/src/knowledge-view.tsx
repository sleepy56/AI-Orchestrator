import { useState } from "react";
import type { KnowledgeData, ProposalData, Task } from "./api";

interface Props { knowledge: KnowledgeData; proposals: ProposalData; tasks: Task[] }

export function KnowledgeView({ knowledge, proposals, tasks }: Props) {
  const [taskId, setTaskId] = useState(tasks[0]?.spec.id ?? "");
  const currentTask = tasks.some((task) => task.spec.id === taskId) ? taskId : tasks[0]?.spec.id;
  const matched = knowledge.retrieval.find((item) => item.taskId === currentTask)?.selections ?? [];
  const used = knowledge.usedInRuns.filter((item) => item.taskId === currentTask);
  const proposal = proposals.proposals.find((item) => item.taskId === currentTask)?.proposal;
  const names = new Map(knowledge.lessons.map((lesson) => [lesson.id, lesson.text]));

  return <>
    <div className="page-intro"><div><div className="eyebrow">REVIEW AND ROUTING</div><h1>Knowledge</h1><p>Reviewed lessons, pending candidates, and recorded run use.</p></div></div>
    <section className="panel knowledge-panel" aria-labelledby="lessons-heading"><div className="panel-header"><div><div className="overline">APPROVED</div><h2 id="lessons-heading">Reviewed lessons</h2></div><span className="panel-count">{knowledge.lessons.length}</span></div>
      {knowledge.lessons.length ? <ul className="knowledge-list">{knowledge.lessons.map((lesson) => <li key={lesson.id}><strong>{lesson.id}</strong><span className="status-pill completed">Approved · {lesson.scope}</span><p>{lesson.text}</p><small>{lesson.taskCategory} category{lesson.sourceRunId ? ` · source run ${lesson.sourceRunId}` : ""}</small></li>)}</ul> : <p className="empty-state">No approved lessons.</p>}
    </section>
    <section className="panel knowledge-panel" aria-labelledby="candidates-heading"><div className="panel-header"><div><div className="overline">AWAITING REVIEW</div><h2 id="candidates-heading">Pending candidates</h2></div><span className="panel-count">{knowledge.candidates.length}</span></div>
      {knowledge.candidates.length ? <ul className="knowledge-list">{knowledge.candidates.map((candidate) => <li key={candidate.id}><strong>{candidate.id}</strong><span className="status-pill">Pending · project</span><p>{candidate.text}</p><small>{candidate.taskCategory} category · {candidate.evidence.length} live validated observation{candidate.evidence.length === 1 ? "" : "s"}</small></li>)}</ul> : <p className="empty-state">No pending candidates.</p>}
    </section>
    <section className="panel knowledge-panel" aria-labelledby="task-knowledge-heading"><div className="panel-header"><div><div className="overline">TASK CONTEXT</div><h2 id="task-knowledge-heading">Retrieval and route proposal</h2></div><label className="category-control">Task <select value={currentTask ?? ""} onChange={(event) => setTaskId(event.target.value)}>{tasks.map((task) => <option key={task.spec.id} value={task.spec.id}>{task.spec.id} · {task.spec.description}</option>)}</select></label></div>
      {currentTask ? <>
        <div className="task-detail-block"><h4>Current retrieval matches · observational</h4><p>These matches are computed from current approved lessons. They do not prove a past run used them.</p>{matched.length ? <ul className="knowledge-list">{matched.map((selection) => <li key={selection.id}><strong>{selection.id}</strong><span className="status-pill">{selection.scope}</span><p>{names.get(selection.id) ?? "Lesson text unavailable"}</p><small>Reason: {selection.reason}</small></li>)}</ul> : <p className="empty-state">No current retrieval matches.</p>}</div>
        <div className="task-detail-block"><h4>Used in runs · recorded IDs and reasons</h4>{used.length ? <ul className="knowledge-list">{used.map((item) => <li key={`${item.runId}-${item.at}`}><strong>Run {item.runId}</strong><span className={`mode-badge ${item.mode}`}>{item.mode === "simulated" ? "Simulated" : "Live"}</span>{item.selections.length ? <ul>{item.selections.map((selection) => <li key={selection.id}>{selection.id} · {selection.scope} · {selection.reason}</li>)}</ul> : <p>No lessons selected.</p>}</li>)}</ul> : <p className="empty-state">No recorded lesson selections for this task.</p>}</div>
        <div className="task-detail-block"><h4>Read-only model route proposal</h4>{proposal ? <div className="recommendation"><strong>{proposal.recommendedAlias ? `Proposed: ${proposal.recommendedAlias}` : `Established route: ${proposal.chosenAlias}`}</strong><p>Fallback: {proposal.fallbackAlias} · {proposal.priceVersion ? `Reviewed price snapshot ${proposal.priceVersion}` : "No reviewed price snapshot"}</p><p>{proposal.reason}</p>{proposal.baseline && <p>Baseline: {proposal.baseline.validatedPasses}/{proposal.baseline.taskCount} tasks passed across {proposal.baseline.attemptCount} attempts, {proposal.baseline.retries} retries, Wilson 95% interval {(proposal.baseline.passRate95[0] * 100).toFixed(0)}–{(proposal.baseline.passRate95[1] * 100).toFixed(0)}%, {proposal.baseline.averageLatencyMs.toFixed(0)} ms average, {proposal.currency} {proposal.baseline.averageCostPerTask.toFixed(6)} estimated per task.</p>}{proposal.candidate && <p>Candidate: {proposal.candidate.validatedPasses}/{proposal.candidate.taskCount} tasks passed across {proposal.candidate.attemptCount} attempts, {proposal.candidate.retries} retries, Wilson 95% interval {(proposal.candidate.passRate95[0] * 100).toFixed(0)}–{(proposal.candidate.passRate95[1] * 100).toFixed(0)}%, {proposal.candidate.averageLatencyMs.toFixed(0)} ms average, {proposal.currency} {proposal.candidate.averageCostPerTask.toFixed(6)} estimated per task.</p>}<p>{proposal.uncertainty}</p></div> : <p className="empty-state">No route proposal available.</p>}</div>
      </> : <p className="empty-state">No tasks in this project.</p>}
    </section>
  </>;
}
