import { useState } from "react";
import type { HistoryAttempt, Model } from "./api";
import { attemptKey, formatLatency, formatTokens, modelKey, realModelAttempts, summarize } from "./evidence";

interface Props { models: Model[]; attempts: HistoryAttempt[]; policyVersion: number }

function date(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function AttemptEvidence({ attempts, empty }: { attempts: HistoryAttempt[]; empty: string }) {
  if (!attempts.length) return <p className="empty-state">{empty}</p>;
  return <ol className="evidence-list">{[...attempts].reverse().map((attempt, index) =>
    <li key={`${attempt.at}-${attempt.taskId}-${index}`}>
      <div className="evidence-row"><strong>{attempt.taskId}</strong><span className={`status-pill ${attempt.passed ? "completed" : "failed"}`}>{attempt.passed ? "✓ Passed" : "! Failed"}</span><span className={`mode-badge ${attempt.simulated ? "simulated" : "live"}`}>{attempt.simulated ? "Simulated" : "Live"}</span></div>
      <div className="evidence-subline"><time dateTime={attempt.at}>{date(attempt.at)}</time> · {attempt.taskType} · {attempt.route} · {attempt.model ?? "Model unrecorded"}</div>
      {attempt.checkCommand && <div className="command"><span>CHECK</span><code>{attempt.checkCommand}</code></div>}
      {attempt.errors.length > 0 && <ul className="errors">{attempt.errors.map((error, errorIndex) => <li key={errorIndex}>{error}</li>)}</ul>}
      <div className="evidence-subline">Tokens: {attempt.inputTokens !== undefined && attempt.outputTokens !== undefined ? (attempt.inputTokens + attempt.outputTokens).toLocaleString() : "unknown"} · Latency: {attempt.latencyMs !== undefined ? `${(attempt.latencyMs / 1000).toFixed(1)}s` : "unknown"}</div>
    </li>)}</ol>;
}

export function ModelsView({ models, attempts, policyVersion }: Props) {
  const [selectedAlias, setSelectedAlias] = useState<string>();
  const selected = models.find((model) => model.alias === selectedAlias) ?? models[0];
  const real = selected ? realModelAttempts(attempts, selected) : [];
  const summary = summarize(real);
  const sharedAliases = selected ? models.filter((model) => modelKey(model) === modelKey(selected)).map((model) => model.alias) : [];

  return <>
    <div className="page-intro"><div><div className="eyebrow">ROUTING INVENTORY</div><h1>Models</h1><p>Configured providers and evidence from recorded live attempts.</p></div><span className="panel-count">Policy version {policyVersion}</span></div>
    <section className="panel models-panel" aria-labelledby="models-heading">
      <div className="panel-header"><div><div className="overline">REGISTRY</div><h2 id="models-heading">Available models</h2></div><span className="panel-count">{models.filter((model) => model.enabled).length} enabled · {models.length} registered</span></div>
      {models.length ? <div className="model-layout"><div className="model-list" role="group" aria-label="Select a model">
        {models.map((model) => {
          const count = realModelAttempts(attempts, model).length;
          return <button key={model.alias} type="button" className={`model-choice ${selected?.alias === model.alias ? "selected" : ""}`} aria-pressed={selected?.alias === model.alias} onClick={() => setSelectedAlias(model.alias)}>
            <span className="model-choice-top"><strong>{model.alias}</strong><span className={`status-pill ${model.enabled ? "ready" : "idle"}`}>{model.enabled ? "○ Enabled" : "⊘ Unavailable"}</span></span>
            <span className="model-choice-id">{model.model ? `${model.provider}:${model.model}` : `${model.provider} · unconfigured`}</span>
            <span className="model-choice-foot">{model.tier} · {model.effort} effort · weight {model.weight} · {count ? `${count} live attempts` : "Untested"}</span>
          </button>;
        })}
      </div>
      {selected && <div className="model-detail" aria-live="polite"><div className="panel-header"><div><div className="overline">MODEL DETAILS</div><h2>{selected.alias}</h2></div><span className="panel-count">{selected.enabled ? "Enabled" : "Unavailable"}</span></div>
        <dl className="model-facts"><div><dt>Provider</dt><dd>{selected.provider}</dd></div><div><dt>Model ID</dt><dd>{selected.model || "Unconfigured"}</dd></div><div><dt>Route / effort</dt><dd>{selected.tier} / {selected.effort}</dd></div><div><dt>Preference weight</dt><dd>{selected.weight}</dd></div><div><dt>Cost</dt><dd>Unknown · no price snapshot</dd></div></dl>
        {selected.provider === "claude" && !selected.enabled && <p className="model-note">Claude execution is unavailable in this project.</p>}
        <div className="model-stat-grid"><div><span>Validated pass rate</span><strong>{summary.attempts ? `${summary.passed}/${summary.attempts} (${Math.round(100 * summary.passed / summary.attempts)}%)` : "Untested"}</strong></div><div><span>Repeat attempts</span><strong>{summary.repeatedAttempts}</strong></div><div><span>Token use</span><strong>{formatTokens(summary)}</strong></div><div><span>Average latency</span><strong>{formatLatency(summary)}</strong></div></div>
        {real.length > 0 && <div className="model-trend"><span>Last {Math.min(10, real.length)} live outcomes</span><span className="outcome-trend" aria-label={`Last ${Math.min(10, real.length)} live outcomes, oldest first: ${real.slice(-10).map((attempt) => attempt.passed ? "passed" : "failed").join(", ")}`}>{real.slice(-10).map((attempt, index) => <i key={index} className={attempt.passed ? "pass" : "fail"} aria-hidden="true" />)}</span></div>}
        <p className="evidence-note">Evidence matches the recorded model ID and route. {sharedAliases.length > 1 ? `These attempts may belong to any of these aliases: ${sharedAliases.join(", ")}.` : "History does not record the chosen alias."} Simulated attempts are excluded.</p>
        <div className="task-detail-block"><h4>Live attempt evidence</h4><AttemptEvidence attempts={real} empty="No live attempts with this model ID and route are recorded." /></div>
      </div>}</div> : <div className="empty-state">No models are registered.</div>}
    </section>
  </>;
}

interface LearningRow { category: string; key: string; model: string; route: string; attempts: HistoryAttempt[]; aliases: Model[] }

function learningRows(models: Model[], attempts: HistoryAttempt[]): LearningRow[] {
  const groups = new Map<string, LearningRow>();
  for (const attempt of attempts) {
    if (attempt.simulated || !attempt.model) continue;
    const key = `${attempt.taskType}|${attemptKey(attempt)}`;
    let row = groups.get(key);
    if (!row) {
      row = { category: attempt.taskType, key, model: attempt.model, route: attempt.route, attempts: [], aliases: models.filter((model) => modelKey(model) === attemptKey(attempt)) };
      groups.set(key, row);
    }
    row.attempts.push(attempt);
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category) || a.model.localeCompare(b.model) || a.route.localeCompare(b.route));
}

export function LearningView({ models, attempts, policyVersion }: Props) {
  const rows = learningRows(models, attempts);
  const categories = [...new Set(rows.map((row) => row.category))];
  const [category, setCategory] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string>();
  const visible = category === "all" ? rows : rows.filter((row) => row.category === category);
  const selected = visible.find((row) => row.key === selectedKey) ?? visible[0];
  const simulated = attempts.filter((attempt) => attempt.simulated);
  const unattributed = attempts.filter((attempt) => !attempt.simulated && !attempt.model);
  const comparative = visible.filter((row) => row.attempts.length >= 5)
    .sort((a, b) => summarize(b.attempts).passed / b.attempts.length - summarize(a.attempts).passed / a.attempts.length);
  const leader = comparative[0];
  const runnerUp = comparative[1];
  const recommendation = category !== "all" && runnerUp &&
    summarize(leader.attempts).passed / leader.attempts.length > summarize(runnerUp.attempts).passed / runnerUp.attempts.length ? leader : undefined;

  return <>
    <div className="page-intro"><div><div className="eyebrow">OBSERVED OUTCOMES</div><h1>Learning</h1><p>Routing evidence from project attempt history. Orch does not retrain underlying models.</p></div><span className="panel-count">Policy version {policyVersion}</span></div>
    <section className="panel learning-summary" aria-labelledby="learning-summary-heading"><div className="panel-header"><div><div className="overline">EVIDENCE SCOPE</div><h2 id="learning-summary-heading">Recorded attempts</h2></div></div>
      <div className="learning-counts"><div><strong>{attempts.filter((attempt) => !attempt.simulated).length}</strong><span>Live attempts</span></div><div><strong>{simulated.length}</strong><span>Simulated attempts</span></div><div><strong>{unattributed.length}</strong><span>Live attempts without model ID</span></div></div>
      <p className="evidence-note">Pass rate uses completed attempt validation results. Repeat attempts count additional records for the same task ID. Token use and latency show their recorded sample counts. Simulated attempts never enter model performance or recommendations.</p>
    </section>
    <section className="panel learning-panel" aria-labelledby="learning-heading"><div className="panel-header"><div><div className="overline">BY TASK CATEGORY AND MODEL</div><h2 id="learning-heading">Routing observations</h2></div><label className="category-control">Category <select value={category} onChange={(event) => { setCategory(event.target.value); setSelectedKey(undefined); }}><option value="all">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
      {visible.length ? <><div className="table-scroll" role="region" aria-label="Routing observations, scroll horizontally for all columns" tabIndex={0}><table className="learning-table"><thead><tr><th scope="col">Category / model</th><th scope="col">Live attempts</th><th scope="col">Validated pass</th><th scope="col">Repeat attempts</th><th scope="col">Token use</th><th scope="col">Avg. latency</th><th scope="col">Weight</th><th scope="col">Recent outcomes</th></tr></thead><tbody>{visible.map((row) => { const stats = summarize(row.attempts); return <tr key={row.key} className={selected?.key === row.key ? "selected" : ""}><th scope="row"><button type="button" className="row-select" aria-pressed={selected?.key === row.key} onClick={() => setSelectedKey(row.key)}><strong>{row.category}</strong><span>{row.model} · {row.route}</span></button></th><td>{stats.attempts}</td><td>{stats.passed}/{stats.attempts} ({Math.round(100 * stats.passed / stats.attempts)}%)</td><td>{stats.repeatedAttempts}</td><td>{formatTokens(stats)}</td><td>{formatLatency(stats)}</td><td>{row.aliases.length ? row.aliases.map((alias) => `${alias.alias}: ${alias.weight}`).join(", ") : "Unregistered"}</td><td><span className="outcome-trend" aria-label={`Last ${Math.min(10, row.attempts.length)} outcomes, oldest first: ${row.attempts.slice(-10).map((attempt) => attempt.passed ? "passed" : "failed").join(", ")}`}>{row.attempts.slice(-10).map((attempt, index) => <i key={index} className={attempt.passed ? "pass" : "fail"} aria-hidden="true" />)}</span></td></tr>; })}</tbody></table></div>
        <div className="recommendation"><strong>{recommendation ? `Observed leader for ${category}: ${recommendation.model} · ${recommendation.route}` : "No comparative recommendation"}</strong><p>{recommendation && runnerUp ? `${summarize(recommendation.attempts).passed}/${recommendation.attempts.length} live attempts passed with ${summarize(recommendation.attempts).repeatedAttempts} repeat attempts; ${runnerUp.model} · ${runnerUp.route} passed ${summarize(runnerUp.attempts).passed}/${runnerUp.attempts.length} with ${summarize(runnerUp.attempts).repeatedAttempts} repeats. These are observations, not causal proof.` : "A recommendation needs a selected category and at least five live attempts for each of two distinct model routes with different pass rates."}</p></div>
        {selected && <div className="task-detail-block"><h4>Selected evidence · {selected.category} / {selected.model} / {selected.route}</h4><AttemptEvidence attempts={selected.attempts} empty="No live evidence recorded." /></div>}</> : <div className="empty-state">No live attempts with a recorded model ID in this category.</div>}
    </section>
    {unattributed.length > 0 && <section className="panel learning-extra" aria-labelledby="unattributed-heading"><div className="panel-header"><div><div className="overline">ROUTE ONLY</div><h2 id="unattributed-heading">Live attempts without model ID</h2></div><span className="panel-count">{unattributed.length}</span></div><p className="evidence-note">These outcomes belong to a route, but cannot safely be attributed to a model.</p><AttemptEvidence attempts={unattributed} empty="No unattributed attempts." /></section>}
    <section className="panel learning-extra" aria-labelledby="simulated-heading"><div className="panel-header"><div><div className="overline">EXCLUDED FROM PERFORMANCE</div><h2 id="simulated-heading">Simulated run attempts</h2></div><span className="mode-badge simulated">◇ Simulated · {simulated.length}</span></div><AttemptEvidence attempts={simulated} empty="No simulated attempts recorded." /></section>
  </>;
}
