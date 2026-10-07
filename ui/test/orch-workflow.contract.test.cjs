const assert = require("node:assert/strict");
const test = require("node:test");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const esbuild = require("../node_modules/esbuild");
const uiRequire = createRequire(join(__dirname, "../src/knowledge-view.tsx"));

test("[TASK-025] UI exposes local run, capacity, integration, routing history, and reviewed learning controls", async () => {
  const modules = await Promise.all(["workflow-view.tsx", "knowledge-view.tsx"].map(async (name) => {
    const built = await esbuild.build({ entryPoints: [join(__dirname, "../src", name)], bundle: true,
      platform: "node", format: "cjs", write: false, external: ["react", "react/jsx-runtime"] });
    const module = { exports: {} };
    new Function("require", "module", "exports", built.outputFiles[0].text)(uiRequire, module, module.exports);
    return module.exports;
  }));
  const workflow = modules.find((item) => item.WorkflowView);
  const knowledgeView = modules.find((item) => item.KnowledgeView);
  assert.ok(workflow && knowledgeView);
  const React = uiRequire("react");
  const { renderToStaticMarkup } = uiRequire("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(workflow.WorkflowView, { initialState: {
    revision: 9, base: { branch: "main", commit: "a".repeat(40) },
    capacity: { availability: "unknown" },
    worktrees: { workers: { "TASK-001": { branch: "orch/task-1", path: "C:/private/worktree", base: "a".repeat(40), validation: { passed: true, command: "npm test", output: "passed" } } },
      integrations: { "integration-1": { id: "integration-1", taskIds: ["TASK-001"], target: "main", base: "a".repeat(40), path: "C:/private/integration", diff: "review diff", conflicts: [], commit: "b".repeat(40), actionId: "approval-1", check: { command: "npm test", passed: true, output: "passed" } } } },
    policy: { version: 2, routing: { limits: { blockedModels: ["luna-low"] }, rules: {} }, history: [{ version: 2, at: "2026-10-07", author: "user", cause: "limits", reason: "cost", before: {}, after: {}, evidenceIds: [], rollbackTo: 1 }] },
    runs: { "run-1": { value: { status: "paused", mode: "live", reason: "Provider capacity" } } },
    jobs: [{ id: "job-1", startedAt: "2026-10-07", status: "running", output: "Starting worker", errorOutput: "" }],
  } }));
  assert.match(html, /remaining quota unknown/);
  assert.match(html, /Pin worktree base/);
  assert.match(html, /Start run/);
  assert.match(html, /Resume run/);
  assert.match(html, /Local run requests.*job-1/);
  assert.match(html, /Integrate and check/);
  assert.match(html, /Merge approved integration/);
  assert.match(html, /Version 2.*user.*limits/);
  assert.match(html, /Restore route rules from version 1/);
  const learning = renderToStaticMarkup(React.createElement(knowledgeView.KnowledgeView, { tasks: [], proposals: { proposals: [] }, knowledge: {
    lessons: [{ id: "reviewed", scope: "project", text: "Inspect public references", taskCategory: "analysis", reviewStatus: "approved", sourceRunId: null }],
    notes: [{ id: "pending", scope: "project", text: "Check references", taskCategory: "analysis", reviewStatus: "pending", sourceRunId: null }],
    candidates: [{ id: "candidate", text: "Inspect similar tasks", taskCategory: "analysis", reviewStatus: "pending", evidence: [{ attemptId: "a", runId: "r", taskId: "t" }] }], retrieval: [], usedInRuns: [],
  } }));
  assert.match(learning, /Approve note/);
  assert.match(learning, /Approve candidate/);
  assert.match(learning, /Promote reviewed lesson/);
  assert.match(learning, /Only approved, generalized project lessons/);
});

test("[TASK-020] UI shows current plan and check gates, paused runs, and distinct merge and deployment approval", async () => {
  const built = await esbuild.build({ entryPoints: [join(__dirname, "../src/planning-view.tsx")], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["react", "react/jsx-runtime"] });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(uiRequire, module, module.exports);
  const React = uiRequire("react");
  const { renderToStaticMarkup } = uiRequire("react-dom/server");
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const actionId = "123e4567-e89b-42d3-a456-426614174001";
  const state = { revision: 5, plan: { revision: 2, value: { draft: { goal: "Ship", status: "review", questions: [], answers: {}, tasks: [] } } },
    checksRevision: 3, approvals: { old: { value: { target: "checks", targetRevision: 2 } }, plan: { value: { target: "plan", targetRevision: 2 } } },
    actions: { [actionId]: { revision: 1, value: { target: "merge", destination: "main", artifactRevision: "a".repeat(40), baseRevision: "b".repeat(40), planRevision: 2, checksRevision: 3 } } },
    runs: { [runId]: { value: { status: "paused", mode: "simulated", reason: "Checks revision 3 awaits approval" } } } };
  const html = renderToStaticMarkup(React.createElement(module.exports.PlanningView, { initialState: state }));
  assert.match(html, /Check set revision 3: Awaiting approval/);
  assert.match(html, /Approve checks revision/);
  assert.match(html, /Paused runs/);
  assert.match(html, new RegExp(`orch run --resume ${runId}`));
  assert.match(html, /Target branch head/);
  assert.match(html, /<option value="deployment">Deployment/);
  assert.match(html, /Approve current plan and checks first/);
  const current = { ...state, approvals: { ...state.approvals, checks: { value: { target: "checks", targetRevision: 3 } } } };
  const approved = renderToStaticMarkup(React.createElement(module.exports.PlanningView, { initialState: current }));
  assert.match(approved, /Paused for user approval/);
  assert.match(approved, /Approve action/);
});

test("[TASK-019] planning UI exposes baseline, editable CLI checks, and separate check outcomes", async () => {
  const built = await esbuild.build({ entryPoints: [join(__dirname, "../src/planning-view.tsx")], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["react", "react/jsx-runtime"] });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(uiRequire, module, module.exports);
  const React = uiRequire("react");
  const { renderToStaticMarkup } = uiRequire("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(module.exports.PlanningView, { initialState: {
    revision: 4, plan: { revision: 2, value: {} }, approvals: {},
  } }));
  assert.match(html, /Run project baseline/);
  assert.match(html, /Add a task check/);
  assert.match(html, /Timeout \(seconds\)/);
  assert.match(html, /Expected outcome/);
  assert.match(html, /Acceptance criterion/);
  assert.match(html, /named human review/);
});

test("[TASK-018] planning view shows consequential questions and reviewable task contracts", async () => {
  const built = await esbuild.build({ entryPoints: [join(__dirname, "../src/planning-view.tsx")], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["react", "react/jsx-runtime"] });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(uiRequire, module, module.exports);
  const React = uiRequire("react");
  const { renderToStaticMarkup } = uiRequire("react-dom/server");
  const base = { revision: 3, plan: { revision: 2, value: { draft: { goal: "Add export support", status: "clarifying",
    questions: [{ id: "format", question: "Which export format?", impact: "Changes parser dependencies" }], answers: {}, tasks: [] } } }, approvals: {} };
  const question = renderToStaticMarkup(React.createElement(module.exports.PlanningView, { initialState: base }));
  assert.match(question, /Which export format\?/);
  assert.match(question, /Changes parser dependencies/);
  assert.match(question, /Answer and draft/);
  const review = renderToStaticMarkup(React.createElement(module.exports.PlanningView, { initialState: { ...base, plan: { revision: 3, value: { draft: { ...base.plan.value.draft,
    status: "review", questions: [], tasks: [{ id: "TASK-101", description: "Implement CSV export", risk: "high", difficulty: "hard", workerProfile: "sol-high", dependsOn: [], acceptanceCriteria: ["Exports CSV headers"], areas: ["src/export"], context: ["README.md"], verification: ["Run export tests"] }] } } } } }));
  assert.match(review, /Exports CSV headers/);
  assert.match(review, /Save revision/);
  assert.match(review, /Approve revision/);
  assert.match(review, /Drafting starts no workers/);
});

test("[TASK-017] project registration view exposes the local manifest and editable document list", async () => {
  const built = await esbuild.build({ entryPoints: [join(__dirname, "../src/project-registration.tsx")], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["react", "react/jsx-runtime"] });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(uiRequire, module, module.exports);
  const React = uiRequire("react");
  const { renderToStaticMarkup } = uiRequire("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(module.exports.ProjectRegistration, {
    data: { registered: true, project: { revision: 2, value: { id: "123e4567-e89b-42d3-a456-426614174000", directory: "C:/local/repo",
      git: { isRepository: true, branch: "main", dirty: false }, scripts: { test: "node test.js" }, context: { version: 2, documents: ["README.md"] } } } },
    onRegistered: () => {},
  }));
  assert.match(html, /Project registration/);
  assert.match(html, /123e4567-e89b-42d3-a456-426614174000/);
  assert.match(html, /README\.md/);
  assert.match(html, /Update registration/);
});

test("[TASK-014] knowledge view distinguishes current retrieval, run use, candidates, and read-only proposals", async () => {
  const built = await esbuild.build({ entryPoints: [join(__dirname, "../src/knowledge-view.tsx")], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["react", "react/jsx-runtime"] });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(uiRequire, module, module.exports);
  const { KnowledgeView } = module.exports;
  const React = uiRequire("react");
  const { renderToStaticMarkup } = uiRequire("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(KnowledgeView, {
    tasks: [{ spec: { id: "TASK-001", description: "Rename public type" } }],
    knowledge: {
      lessons: [{ id: "reviewed-1", scope: "project", text: "Inspect references", taskCategory: "rename", reviewStatus: "approved", sourceRunId: null }],
      candidates: [{ id: "candidate-1", text: "Check consumers", taskCategory: "rename", reviewStatus: "pending", evidence: [{ attemptId: "a1", runId: "r1", taskId: "TASK-001" }] }],
      retrieval: [{ taskId: "TASK-001", selections: [{ id: "reviewed-1", scope: "project", reason: "category rename" }] }],
      usedInRuns: [{ runId: "r1", taskId: "TASK-001", at: "2026-01-01", mode: "live", lessonIds: ["historical-1"], selections: [{ id: "historical-1", scope: "project", reason: "past context" }] }],
    },
    proposals: { proposals: [{ taskId: "TASK-001", proposal: { chosenAlias: "luna-low", fallbackAlias: "luna-low", reason: "Insufficient live evidence", uncertainty: "Observed tasks only" } }] },
  }));
  assert.match(html, /Current retrieval matches · observational/);
  assert.match(html, /Used in runs · recorded IDs and reasons/);
  assert.match(html, /historical-1/);
  assert.match(html, /candidate-1/);
  assert.match(html, /No reviewed price snapshot/);
  assert.match(html, /Insufficient live evidence/);
});

test("[TASK-015] knowledge view keeps historical run use separate from current observational retrieval", async () => {
  const built = await esbuild.build({ entryPoints: [join(__dirname, "../src/knowledge-view.tsx")], bundle: true,
    platform: "node", format: "cjs", write: false, external: ["react", "react/jsx-runtime"] });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(uiRequire, module, module.exports);
  const React = uiRequire("react");
  const { renderToStaticMarkup } = uiRequire("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(module.exports.KnowledgeView, {
    tasks: [{ spec: { id: "TASK-001", description: "Rename public references" } }],
    knowledge: {
      lessons: [{ id: "current-only", scope: "global", text: "Inspect current references", taskCategory: "rename", reviewStatus: "approved", sourceRunId: null }],
      candidates: [{ id: "pending-live", text: "Inspect similar tasks", taskCategory: "rename", reviewStatus: "pending", evidence: [{ attemptId: "a1", runId: "live-run", taskId: "TASK-001" }] }],
      retrieval: [{ taskId: "TASK-001", selections: [{ id: "current-only", scope: "global", reason: "category rename" }] }],
      usedInRuns: [
        { runId: "old-live", taskId: "TASK-001", at: "2026-01-01", mode: "live", lessonIds: ["historical-only"], selections: [{ id: "historical-only", scope: "project", reason: "past context" }] },
        { runId: "old-simulated", taskId: "TASK-001", at: "2026-01-02", mode: "simulated", lessonIds: [], selections: [] },
      ],
    },
    proposals: { proposals: [{ taskId: "TASK-001", proposal: { chosenAlias: "sol-medium", fallbackAlias: "sol-medium", reason: "Insufficient live evidence", uncertainty: "Observed tasks only" } }] },
  }));
  const currentSection = html.split("Current retrieval matches · observational")[1].split("Used in runs · recorded IDs and reasons")[0];
  const runSection = html.split("Used in runs · recorded IDs and reasons")[1].split("Read-only model route proposal")[0];
  assert.match(currentSection, /current-only.*category rename/);
  assert.doesNotMatch(currentSection, /historical-only|pending-live/);
  assert.match(runSection, /old-live.*Live.*historical-only.*past context/);
  assert.match(runSection, /old-simulated.*Simulated.*No lessons selected/);
  assert.doesNotMatch(runSection, /current-only|pending-live/);
  assert.match(html, /1 live validated observation/);
  assert.match(html, /Fallback: sol-medium/);
});
