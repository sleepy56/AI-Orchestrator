import { useEffect, useState, type FormEvent } from "react";
import { registerProject, type ProjectData } from "./api";

export function ProjectRegistration({ data, onRegistered }: { data: ProjectData; onRegistered: () => void }) {
  const project = data.registered ? data.project.value : undefined;
  const [documents, setDocuments] = useState(project?.context?.documents.join("\n") ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setDocuments(project?.context?.documents.join("\n") ?? ""), [project?.context?.version, project?.id]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await registerProject(documents.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
      onRegistered();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  return <section className="panel project-registration" aria-labelledby="project-heading">
    <div className="overline">LOCAL PROJECT</div><h1 id="project-heading">{project ? "Project registration" : "Register this repository"}</h1>
    <p>Orch records Git status and package scripts locally. Choose the repository documents workers may use as context.</p>
    <dl><div><dt>Directory</dt><dd>{data.registered ? data.project.value.directory : data.directory}</dd></div>
      {project && <><div><dt>Project ID</dt><dd>{project.id}</dd></div><div><dt>Git</dt><dd>{project.git?.isRepository ? `${project.git.branch || "detached"} · ${project.git.dirty ? "changes present" : "clean"}` : "No Git repository detected"}</dd></div><div><dt>Scripts</dt><dd>{Object.keys(project.scripts ?? {}).join(", ") || "None found"}</dd></div><div><dt>Context version</dt><dd>{project.context?.version ?? "Not registered"}</dd></div></>}
    </dl>
    <form onSubmit={(event) => void submit(event)}><label htmlFor="context-documents">Context documents, one repository-relative path per line</label>
      <textarea id="context-documents" value={documents} onChange={(event) => setDocuments(event.target.value)} rows={6} placeholder={"README.md\ndocs/architecture.md"} />
      {error && <p role="alert" className="project-error">{error}</p>}
      <button type="submit" disabled={saving}>{saving ? "Saving…" : project ? "Update registration" : "Register project"}</button>
    </form>
  </section>;
}
