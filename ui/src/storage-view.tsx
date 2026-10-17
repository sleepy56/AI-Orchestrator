import { useEffect, useState } from "react";
import { loadStorage, storageAction, type StorageEnvironment, type StorageState } from "./api";

export function StorageView({ projectDirectory }: { projectDirectory: string }) {
  const [state, setState] = useState<StorageState>();
  const [environment, setEnvironment] = useState<StorageEnvironment>("development");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => { try { setState(await loadStorage()); setError(""); } catch (cause) { setState(undefined); throw cause; } };
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  const act = async (action: "diagnose" | "sync") => {
    setBusy(true); setError("");
    try { await storageAction(action, environment); await refresh(); }
    catch (cause) {
      try { await refresh(); } catch { /* Keep the action error visible. */ }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setBusy(false); }
  };
  const selected = state?.environments[environment];
  const target = selected?.configuration.destination;
  const tables = selected?.lastConnectivityCheck?.tables;
  return <div className="storage-view">
    <div className="page-intro"><div><div className="eyebrow">DATA LOCATION</div><h1>Storage</h1><p>Review local records and explicitly check or sync one shared destination.</p></div></div>
    <section className="panel"><h2>Local project</h2><p>Orch serves this repository from <strong>{projectDirectory}</strong>.</p><p>Plans, tasks, checks, approvals, run details, and private project knowledge stay local. Local history remains available without a shared destination.</p><a href="#project">View repository registration</a></section>
    <section className="panel"><h2>Shared metadata boundary</h2><p>Only allowlisted run metadata and approved, generalized global lessons are eligible for explicit sync. Private paths, credentials, project notes, task content, and local approval history stay local.</p><p>Eligible local metadata is a projection, not proof that any destination received it.</p>
      <label htmlFor="storage-environment">Destination environment</label><select id="storage-environment" value={environment} disabled={busy} onChange={(event) => { setEnvironment(event.target.value as StorageEnvironment); setError(""); }}><option value="development">Development</option><option value="production">Production</option></select>
      <p>Pending local changes: <strong>{selected ? selected.pendingLocalChanges ? "Yes" : "No" : "Unavailable"}</strong></p>
      {selected?.lastSuccess && selected.pendingLocalChanges && <p role="status">Local changes are pending after this sync receipt.</p>}
      <p>Destination identity: <strong>{target ? `${target.host}/${target.database} · public schema` : "No destination configured"}</strong></p>
      {selected?.configuration.error && <p role="status">Configuration: {selected.configuration.error}</p>}
      {error && <p className="error-banner" role="alert">Storage unavailable: {error}</p>}
      {!state && !error && <p role="status">Loading storage state…</p>}
      {selected && <div className="storage-receipts">
        <div><h3>Last successful sync</h3><p>{selected.lastSuccess?.at ?? "Never synced"}{selected.lastSuccess?.counts && ` · ${selected.lastSuccess.counts.runs} runs · ${selected.lastSuccess.counts.lessons} lessons`}</p></div>
        <div><h3>Last connectivity check</h3><p>{selected.lastConnectivityCheck ? `${selected.lastConnectivityCheck.at} · ${selected.lastConnectivityCheck.ok ? "Reachable" : "Failed"}${selected.lastConnectivityCheck.error ? ` · ${selected.lastConnectivityCheck.error}` : ""}` : "Never checked"}</p></div>
        <div><h3>Latest failure</h3><p>{selected.latestFailedAttempt ? `${selected.latestFailedAttempt.at} · ${selected.latestFailedAttempt.error}` : "None recorded"}</p></div>
      </div>}
      {tables && <table aria-label="Diagnostic tables"><thead><tr><th>Public table</th><th>State</th><th>Rows</th></tr></thead><tbody>{Object.entries(tables).map(([name, table]) => <tr key={name}><td>{name}</td><td>{table.present ? "Present" : "Missing"}</td><td>{table.count ?? "Unknown"}</td></tr>)}</tbody></table>}
      <div className="planning-actions"><button type="button" disabled={busy || !selected} onClick={() => void act("diagnose")}>Check {environment} connection</button><button type="button" disabled={busy || !selected?.configuration.configured} onClick={() => void act("sync")}>Sync eligible metadata to {environment}</button><button type="button" disabled={busy} onClick={() => void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>Refresh status</button></div>
    </section>
  </div>;
}
