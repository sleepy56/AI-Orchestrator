import { expect, test, type Page, type TestInfo } from "@playwright/test";

const unconfiguredStorage = { configuration: { configured: false, destination: null, error: "Not configured" }, pendingLocalChanges: false, lastSuccess: null, lastConnectivityCheck: null, latestFailedAttempt: null };
const runId = "11111111-1111-1111-1111-111111111111";
const simulatedId = "22222222-2222-2222-2222-222222222222";
const at = "2026-01-01T00:00:00.000Z";
const tasks = Array.from({ length: 20 }, (_, index) => {
  const number = index + 1;
  const id = `TASK-${String(number).padStart(3, "0")}`;
  return { spec: { id, description: `Visual check task ${number}`, dependsOn: number > 4 ? [`TASK-${String(number - 4).padStart(3, "0")}`] : [], type: "test", difficulty: "moderate", risk: "medium" }, status: "pending", attempts: [] };
});
const attempt = { attempt: 1, route: { label: "sol-medium" }, model: "codex:gpt-6-sol", validation: { passed: false, errors: ["Fixture validation failed"] }, checkCommand: "npm test", response: "Fixture worker response" };
const event = (sequence: number, type: string, extra = {}) => ({ runId, sequence, at, type, ...extra });
const events = [
  event(1, "run.started", { mode: "live", tasks, policyVersion: 1 }),
  event(2, "task.started", { taskId: "TASK-001" }),
  event(3, "route.decided", { taskId: "TASK-001", attempt: 1, route: { label: "sol-medium" }, chosenAlias: "sol-medium", chosenModel: "codex:gpt-6-sol", reason: "Fixture route", policyVersion: 1 }),
  event(4, "attempt.started", { taskId: "TASK-001", attempt: 1, route: { label: "sol-medium" } }),
  event(5, "attempt.finished", { taskId: "TASK-001", attempt, simulated: false }),
  event(6, "task.finished", { taskId: "TASK-001", status: "failed", failureReason: "Fixture validation failed" }),
  event(7, "run.finished", { blocked: ["TASK-005"] }),
];
const simulatedEvents = [
  { ...event(1, "run.started", { mode: "simulated", tasks, policyVersion: 1 }), runId: simulatedId },
  { ...event(2, "task.started", { taskId: "TASK-001" }), runId: simulatedId },
  { ...event(3, "task.finished", { taskId: "TASK-001", status: "completed" }), runId: simulatedId },
  { ...event(4, "run.finished", { blocked: [] }), runId: simulatedId },
];
const models = [
  { alias: "sol-medium", provider: "codex", model: "gpt-6-sol", tier: "sol-medium", effort: "medium", enabled: true, weight: 1 },
  { alias: "luna-low", provider: "codex", model: "gpt-6-luna", tier: "luna-low", effort: "low", enabled: true, weight: 1 },
];
const history = [
  { kind: "attempt", at, taskId: "TASK-001", taskType: "test", difficulty: "moderate", risk: "medium", route: "sol-medium", model: "codex:gpt-6-sol", passed: false, errors: ["Fixture validation failed"], simulated: false },
  { kind: "attempt", at, taskId: "TASK-002", taskType: "test", difficulty: "moderate", risk: "medium", route: "sol-medium", model: "codex:gpt-6-sol", passed: true, errors: [], simulated: true },
];

async function mockApi(page: Page, empty = false) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === "/api/project") body = { registered: true, project: { revision: 1, value: { id: "fixture-project", directory: "/fixture", git: { isRepository: true } } } };
    else if (url.pathname === "/api/commands") body = { revision: 1, plan: { revision: 1, value: {} }, checksRevision: 1, approvals: {} };
    else if (url.pathname === "/api/checks") body = { rows: [], counts: { pass: 0, fail: 0, skipped: 0, missing: 0, unrun: 0 } };
    else if (url.pathname === "/api/storage") body = { environments: {
      development: { ...unconfiguredStorage, configuration: { configured: true, destination: { host: "dev.example", database: "orch" }, error: null }, pendingLocalChanges: true },
      production: { ...unconfiguredStorage, configuration: { configured: true, destination: { host: "prod.example", database: "orch" }, error: null }, lastSuccess: { at } },
    } };
    else if (url.pathname === "/api/workflow") body = { revision: 1, base: null, capacity: { availability: "unknown" }, worktrees: { workers: {}, integrations: {} }, policy: { version: 1, routing: { limits: {}, rules: {} }, history: [] }, runs: {} };
    else if (url.pathname === "/api/tasks") body = { tasks: empty ? [] : tasks.map((task) => ({ ...task, displayStatus: task.spec.dependsOn.length ? "blocked" : "ready" })) };
    else if (url.pathname === "/api/models") body = { models: empty ? [] : models, policyVersion: 1 };
    else if (url.pathname === "/api/history") body = { attempts: empty ? [] : history };
    else if (url.pathname === "/api/knowledge") body = empty ? { lessons: [], candidates: [], retrieval: [], usedInRuns: [] } : {
      lessons: [{ id: "reviewed-1", scope: "project", text: "Inspect public references", taskCategory: "test", reviewStatus: "approved", sourceRunId: null }],
      candidates: [{ id: "candidate-1", text: "Check consumers", taskCategory: "test", reviewStatus: "pending", evidence: [{ attemptId: "a1", runId, taskId: "TASK-001" }] }],
      retrieval: [{ taskId: "TASK-001", selections: [{ id: "reviewed-1", scope: "project", reason: "category test" }] }],
      usedInRuns: [{ runId, taskId: "TASK-001", at, mode: "live", lessonIds: ["historical-1"], selections: [{ id: "historical-1", scope: "project", reason: "past task context" }] }],
    };
    else if (url.pathname === "/api/model-proposals") body = { proposals: empty ? [] : [{ taskId: "TASK-001", proposal: { chosenAlias: "sol-medium", fallbackAlias: "sol-medium", reason: "Insufficient comparable live evidence", uncertainty: "Observations do not prove success" } }] };
    else if (url.pathname === "/api/runs") body = { runs: empty ? [] : [
      { runId, mode: "live", startedAt: at, lastSequence: 7, status: "finished" },
      { runId: simulatedId, mode: "simulated", startedAt: at, lastSequence: 4, status: "finished" },
    ] };
    else if (url.pathname === `/api/runs/${runId}/events`) body = { events: events.filter((item) => item.sequence > Number(url.searchParams.get("after") ?? 0)) };
    else if (url.pathname === `/api/runs/${simulatedId}/events`) body = { events: simulatedEvents.filter((item) => item.sequence > Number(url.searchParams.get("after") ?? 0)) };
    else throw new Error(`Unexpected API request: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function seek(page: Page, sequence: number) {
  const slider = page.getByRole("slider", { name: /Event/ });
  await slider.focus();
  await slider.press("Home");
  for (let index = 1; index < sequence; index++) await slider.press("ArrowRight");
}

test("UI-TASK-002 shows recorded goal, next decision, and current counts during historical replay", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/commands", (route) => route.fulfill({ json: {
    revision: 3, plan: { revision: 2, value: { draft: { goal: "Ship the fixture dashboard", status: "clarifying", questions: [{ id: "scope", question: "Which dashboard view first?", impact: "Sets scope" }], answers: {}, tasks: [] } } }, checksRevision: 1, approvals: {},
  } }));
  await page.route("**/api/tasks", (route) => route.fulfill({ json: { tasks: tasks.map((task, index) => ({ ...task, status: index === 0 ? "completed" : "pending", displayStatus: index === 0 ? "completed" : task.spec.dependsOn.length ? "blocked" : "ready" })) } }));
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Ship the fixture dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Answer planning questions" })).toBeVisible();
  await expect(page.locator(".next-action")).toContainText("Which dashboard view first?");
  await expect(page.getByRole("region", { name: "Current project status" }).locator(".metric").nth(2).locator(".metric-value")).toHaveText("01");
  await page.getByRole("link", { name: "View Runs" }).first().click();
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  await seek(page, 3);
  await expect(page.locator(".timeline-current")).toContainText("Historical run");
  await expect(page.locator(".timeline-current")).toContainText("Selected historical time");
  await expect(page.locator(".graph-node.running")).toHaveCount(1);
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("region", { name: "Current project status" }).locator(".metric").nth(2).locator(".metric-value")).toHaveText("01");
  await expect(page.locator(".overview-tasks")).toContainText("Visual check task 1");
});

test("UI-TASK-002 labels empty, simulated, paused, and offline states", async ({ page }) => {
  await mockApi(page, true);
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "No goal recorded yet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Describe a goal" })).toBeVisible();
  await expect(page.locator(".overview-tasks")).toHaveCount(0);
  await expect(page.getByText("No run events recorded yet.")).toBeVisible();
  await page.route("**/api/project", (route) => route.fulfill({ status: 503, json: { error: "offline" } }));
  await page.getByRole("button", { name: /Refresh/ }).click();
  await expect(page.getByRole("heading", { name: "Overview unavailable" })).toBeVisible();
  await expect(page.getByText(/Current goal, tasks, and activity cannot be confirmed/)).toBeVisible();
});

test("UI-TASK-002 names simulated activity and a paused run action", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/commands", (route) => route.fulfill({ json: {
    revision: 3, plan: { revision: 2, value: { draft: { goal: "Review fixture work", status: "review", questions: [], answers: {}, tasks: [] } } }, checksRevision: 1,
    approvals: { plan: { value: { target: "plan", targetRevision: 2 } }, checks: { value: { target: "checks", targetRevision: 1 } } },
  } }));
  await page.route("**/api/workflow", (route) => route.fulfill({ json: { revision: 1, base: null, capacity: { availability: "unknown" }, worktrees: { workers: {}, integrations: {} }, policy: { version: 1, routing: { limits: {}, rules: {} }, history: [] }, runs: { [runId]: { value: { status: "paused", mode: "live", reason: "Waiting for capacity" } } } } }));
  await page.route("**/api/runs", (route) => route.fulfill({ json: { runs: [{ runId: simulatedId, mode: "simulated", startedAt: at, lastSequence: 4, status: "finished" }] } }));
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Resume paused run" })).toBeVisible();
  await expect(page.locator(".next-action")).toContainText("Waiting for capacity");
  await expect(page.locator(".activity-context")).toContainText("Simulated run");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Runs" }).click();
  await expect(page.locator(".timeline-panel")).toContainText("Simulated run");
});

test("UI-TASK-002 treats a recorded running task without a live job as possibly interrupted", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/commands", (route) => route.fulfill({ json: {
    revision: 3, plan: { revision: 2, value: { draft: { goal: "Complete fixture work", status: "review", questions: [], answers: {}, tasks: [] } } }, checksRevision: 1,
    approvals: { plan: { value: { target: "plan", targetRevision: 2 } }, checks: { value: { target: "checks", targetRevision: 1 } } },
  } }));
  await page.route("**/api/tasks", (route) => route.fulfill({ json: { tasks: tasks.map((task, index) => ({ ...task, status: index === 0 ? "running" : "pending", displayStatus: index === 0 ? "possibly-interrupted" : "blocked" })) } }));
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Inspect possibly interrupted work" })).toBeVisible();
  await expect(page.locator(".next-action")).toContainText("before retrying");
  await expect(page.getByRole("region", { name: "Current project status" }).locator(".metric").nth(1).locator(".metric-value")).toHaveText("01");
});

test("timeline replay changes graph, worker, and validation evidence without future state", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/#workflow");
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  await page.getByText("Advanced worker and routing view").click();
  await expect(page.getByRole("heading", { name: "Timeline replay" })).toBeVisible();
  await expect(page.locator(".graph-node.failed")).toHaveCount(1);
  await expect(page.locator(".graph-node.failed")).toHaveCSS("border-left-color", "rgb(158, 62, 50)");
  await expect(page.locator(".graph-node.failed-descendant")).toHaveCount(4);
  await expect(page.getByText("Fixture validation failed").first()).toBeVisible();
  await capture(page, testInfo, "failed-run-overview");

  await seek(page, 3);
  await expect(page.locator(".graph-node.running")).toHaveCount(1);
  await expect(page.locator(".graph-node.running")).toHaveCSS("border-left-color", "rgb(164, 77, 49)");
  await expect(page.locator(".graph-node.failed")).toHaveCount(0);
  await expect(page.locator(".validation-panel")).toContainText("No validation result recorded yet");
  await expect(page.getByLabel("Worker details")).toContainText("Fixture route");
  await capture(page, testInfo, "route-decision-replay");

  await page.getByRole("button", { name: "Next event" }).click();
  await expect(page.getByLabel("Worker details")).toContainText("TASK-001 · attempt 1");
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await expect(page.locator(".graph-node.failed")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Select run" }).selectOption(simulatedId);
  await expect(page.locator(".timeline-panel")).toContainText("Simulated run");
  await expect(page.locator(".graph-node.completed")).toHaveCount(1);
  await capture(page, testInfo, "simulated-completed-run");
});

test("empty project has clear run, graph, and worker states", async ({ page }, testInfo) => {
  await mockApi(page, true);
  await page.goto("/#workflow");
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  await page.getByText("Advanced worker and routing view").click();
  await expect(page.getByRole("heading", { name: "No runs yet" })).toBeVisible();
  await expect(page.locator(".timeline-panel")).toContainText("No run events recorded yet");
  await expect(page.locator(".graph-section")).toContainText("No tasks in this project yet");
  await expect(page.locator(".worker-section")).toContainText("No enabled workers are configured");
  await capture(page, testInfo, "empty-project");
});

test("dense graph and worker map remain readable and keyboard operable", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/#workflow");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  await page.getByText("Advanced worker and routing view").click();
  const graph = page.getByRole("region", { name: /Task dependency graph/ });
  await expect(graph.locator("button.graph-node")).toHaveCount(20);
  const positions = await graph.locator("button.graph-node").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
    const x = Math.min(positions[a].right, positions[b].right) - Math.max(positions[a].left, positions[b].left);
    const y = Math.min(positions[a].bottom, positions[b].bottom) - Math.max(positions[a].top, positions[b].top);
    expect(x <= 0 || y <= 0, `Graph nodes ${a + 1} and ${b + 1} overlap`).toBeTruthy();
  }
  await graph.getByRole("button", { name: /TASK-001:/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(graph.getByRole("button", { name: /TASK-005:/ })).toBeFocused();
  await expect(page.getByRole("heading", { name: "TASK-005" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(graph.getByRole("button", { name: /TASK-020:/ })).toBeFocused();
  await capture(page, testInfo, "dense-graph-keyboard");

  const worker = page.getByRole("button", { name: /sol-medium, codex:gpt-6-sol/ });
  await worker.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: /luna-low, codex:gpt-6-luna/ })).toBeFocused();
  await expect(page.getByLabel("Worker details")).toContainText("luna-low");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Worker details")).toBeFocused();
});

test("small viewport keeps timeline controls and selected evidence accessible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/#workflow");
  await seek(page, 5);
  await expect(page.locator(".validation-panel")).toContainText("Checks need attention");
  const controls = page.locator(".timeline-controls");
  const box = await controls.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await capture(page, testInfo, "mobile-validation-replay");
});

test("Models and Learning keep live and simulated evidence visually distinct", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await page.locator(".advanced-nav summary").click();
  await page.getByRole("link", { name: /Models/ }).click();
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(page.locator(".model-detail")).toContainText("0/1 (0%)");
  await capture(page, testInfo, "models-live-evidence");
  await page.getByRole("link", { name: /Learning/ }).click();
  await expect(page.getByRole("heading", { name: "Learning", exact: true })).toBeVisible();
  await expect(page.locator(".learning-counts div").first().locator("strong")).toHaveText("1");
  await expect(page.locator(".learning-extra").last()).toContainText("Simulated run attempts");
  await capture(page, testInfo, "learning-simulated-evidence");
});

test("UI-TASK-001 shell keeps primary and advanced hash routes reachable", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#overview");
  const main = page.getByRole("navigation", { name: "Main navigation" });
  for (const [label, hash] of [["Overview", "#overview"], ["Plan", "#planning"], ["Runs", "#workflow"], ["Knowledge", "#knowledge"], ["Storage", "#storage"]]) {
    await expect(main.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", hash);
  }
  await main.getByRole("link", { name: "Storage" }).click();
  await expect(page).toHaveURL(/#storage$/);
  await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "228px");
  await expect(page.locator(".topbar")).toHaveCSS("height", "76px");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 249, 246)");
  await main.getByRole("link", { name: "Plan" }).click();
  await expect(page).toHaveURL(/#planning$/);
  await expect(page.getByRole("heading", { name: "AI planning draft" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI planning draft" })).toHaveCSS("font-family", /Georgia/);
  await main.getByRole("link", { name: "Runs" }).click();
  await expect(page).toHaveURL(/#workflow$/);
  await expect(page.getByRole("heading", { name: "Runs and routing" })).toBeVisible();
  await page.locator(".advanced-nav summary").click();
  for (const [label, hash] of [["Project", "#project"], ["Models", "#models"], ["Learning", "#learning"]]) {
    await expect(page.getByRole("navigation", { name: "Advanced navigation" }).getByRole("link", { name: label })).toHaveAttribute("href", hash);
  }
  await page.getByRole("navigation", { name: "Advanced navigation" }).getByRole("link", { name: "Models" }).click();
  await expect(page).toHaveURL(/#models$/);
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Advanced navigation" }).getByRole("link", { name: "Learning" }).click();
  await expect(page).toHaveURL(/#learning$/);
  await expect(page.getByRole("heading", { name: "Learning", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Active repository: fixture/ }).click();
  await expect(page).toHaveURL(/#project$/);
});

test("UI-TASK-001 shows the active served repository and persists theme", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const identity = page.getByRole("link", { name: /Active repository: fixture/ });
  await expect(identity).toContainText("fixture");
  await expect(identity).toHaveAttribute("href", "#project");
  await identity.click();
  await expect(page.getByRole("heading", { name: "Project registration" })).toBeVisible();
  await expect(page.locator(".project-registration")).toContainText("/fixture");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(36, 36, 32)");
  await expect(page.locator(".panel").first()).toHaveCSS("background-color", "rgb(45, 46, 40)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("UI-TASK-001 keyboard focus and narrow navigation stay usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApi(page);
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /Active repository: fixture/ })).toBeFocused();
  await expect(page.getByRole("link", { name: /Active repository: fixture/ })).toHaveCSS("outline-style", "solid");
  await expect(page.locator(".sidebar")).toHaveCSS("flex-direction", "column");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator(".advanced-nav summary").click();
  await expect(page.getByRole("navigation", { name: "Advanced navigation" }).getByRole("link", { name: "Project" })).toBeVisible();
  const motion = await page.evaluate(() => {
    const element = document.createElement("div");
    element.style.animation = "pulse 2s infinite";
    element.style.transition = "opacity 2s";
    document.body.append(element);
    const style = getComputedStyle(element);
    const durations = [style.animationDuration, style.transitionDuration];
    element.remove();
    return durations;
  });
  for (const duration of motion) expect(Number.parseFloat(duration)).toBeLessThan(0.001);
});

test("Knowledge separates current matches from IDs used in a run", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#knowledge");
  await expect(page.getByRole("heading", { name: "Reviewed lessons" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending candidates" })).toBeVisible();
  await expect(page.getByText("Current retrieval matches · observational")).toBeVisible();
  await expect(page.getByText("historical-1", { exact: false })).toBeVisible();
  await expect(page.getByText("Insufficient comparable live evidence")).toBeVisible();
});

test("UI-TASK-003 defaults to readable tasks and opens evidence from list and graph", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#workflow");
  const list = page.locator(".runs-task-list");
  await expect(page.getByRole("button", { name: "Task list" })).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("button")).toHaveCount(20);
  await expect(list.getByRole("button").first()).toContainText("No dependencies");
  const trigger = list.getByRole("button").first();
  await trigger.focus();
  await trigger.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Visual check task 1" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(`Live historical run ${runId}`);
  await expect(drawer.getByRole("tabpanel")).toContainText("Fixture worker response");
  await drawer.getByRole("tab", { name: "Checks" }).click();
  await expect(drawer.getByRole("tabpanel")).toContainText("Fixture validation failed");
  await expect(drawer.getByRole("tabpanel")).toContainText("npm test");
  await drawer.getByRole("tab", { name: "Model or routing" }).click();
  await expect(drawer.getByRole("tabpanel")).toContainText("Fixture route");
  await expect(drawer.getByRole("tabpanel")).toContainText("tokens Unknown · latency Unknown");
  await drawer.getByRole("tab", { name: "Recorded knowledge" }).click();
  await expect(drawer.getByRole("tabpanel")).toContainText("historical-1");
  await expect(drawer.getByRole("tabpanel")).not.toContainText("reviewed-1");
  for (const name of ["Result", "Checks", "Model or routing", "Branch", "Recorded knowledge"]) {
    await drawer.getByRole("tab", { name, exact: true }).click();
    await drawer.getByRole("tabpanel").focus();
    for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  const graph = page.getByRole("region", { name: /Task dependency graph/ });
  await graph.getByRole("button", { name: /TASK-001:/ }).click();
  await expect(drawer).toBeVisible();
  await page.locator(".task-drawer-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(graph.getByRole("button", { name: /TASK-001:/ })).toBeFocused();
  await page.getByRole("combobox", { name: "Select run" }).selectOption(simulatedId);
  await page.getByRole("button", { name: "Task list" }).click();
  await list.getByRole("button").first().click();
  await expect(page.getByRole("dialog", { name: "Visual check task 1" })).toContainText(`Simulated historical run ${simulatedId}`);
});

test("UI-TASK-003 dense graph keyboard, replay boundary and unknown evidence", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#workflow");
  await seek(page, 3);
  await page.getByRole("button", { name: "Dependencies", exact: true }).click();
  const graph = page.getByRole("region", { name: /Task dependency graph/ });
  await graph.getByRole("button", { name: /TASK-001:/ }).focus();
  await page.keyboard.press("End");
  await expect(graph.getByRole("button", { name: /TASK-020:/ })).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Visual check task 1" });
  await expect(drawer.getByRole("tabpanel")).toContainText("No worker output recorded");
  await drawer.getByRole("tab", { name: "Checks" }).click();
  await expect(drawer.getByRole("tabpanel")).toContainText("No validation result recorded");
  await drawer.getByRole("tab", { name: "Recorded knowledge" }).click();
  await expect(drawer.getByRole("tabpanel")).toContainText("No knowledge selection recorded");
  await drawer.getByRole("tab", { name: "Branch" }).click();
  await expect(drawer.getByRole("tabpanel")).toContainText("Worktree state at this historical event is unknown");
  await page.keyboard.press("Escape");
  await expect(graph.getByRole("button", { name: /TASK-001:/ })).toBeFocused();
});

test("UI-TASK-003 mobile drawer fits viewport and links only recorded worktrees", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.route("**/api/workflow", (route) => route.fulfill({ json: { revision: 1, base: null, capacity: { availability: "unknown" }, worktrees: { workers: { "TASK-001": { branch: "orch/task-001", path: "/fixture/worktree", base: "abc" } }, integrations: {} }, policy: { version: 1, routing: { limits: {}, rules: {} }, history: [] }, runs: {} } }));
  await page.goto("/#workflow");
  await page.locator(".runs-task-list button").first().click();
  const drawer = page.getByRole("dialog", { name: "Visual check task 1" });
  const box = await drawer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await drawer.getByRole("tab", { name: "Branch" }).click();
  await expect(drawer.getByRole("tabpanel")).toContainText("Current local worktree record");
  await expect(drawer.getByRole("link", { name: "View worktree review" })).toHaveAttribute("href", "#worktree-review");
  await drawer.getByRole("link", { name: "View worktree review" }).click();
  await expect(page).toHaveURL(/#workflow$/);
  await expect(page.getByRole("heading", { name: "Worktree review" })).toBeVisible();
  await expect(page.locator("#worktree-review")).toBeFocused();
});

test("UI-TASK-004 shows check coverage and exact revision approval", async ({ page }) => {
  await mockApi(page);
  const commands: unknown[] = [];
  await page.route("**/api/commands", (route) => {
    if (route.request().method() === "POST") { commands.push(route.request().postDataJSON()); return route.fulfill({ json: { revision: 8, auditId: "audit", subjectId: "checks" } }); }
    return route.fulfill({ json: { revision: 7, plan: { revision: 4, value: { draft: { goal: "Review", status: "review", questions: [], answers: {}, tasks: [] } } }, checksRevision: 3, approvals: {} } });
  });
  await page.route("**/api/checks", (route) => route.fulfill({ json: { rows: [{ id: "missing:TASK-001:0", taskId: "TASK-001", criterion: "Runs", phase: "task", expected: "Runs", revision: 3, status: "missing" }], counts: { pass: 0, fail: 0, skipped: 0, missing: 1, unrun: 0 } } }));
  await page.goto("/#planning");
  await expect(page.getByRole("status")).toContainText("1 criterion without a check");
  await expect(page.getByRole("status")).toContainText("Review and approve this check revision");
  await page.getByRole("button", { name: "Approve revision", exact: true }).click();
  await page.getByRole("button", { name: "Approve checks revision" }).click();
  expect(commands).toContainEqual({ version: 1, kind: "approval.grant", expectedRevision: 7, payload: { target: "plan", targetRevision: 4, actor: "user" } });
  expect(commands).toContainEqual({ version: 1, kind: "approval.grant", expectedRevision: 7, payload: { target: "checks", targetRevision: 3, actor: "user" } });
});

test("UI-TASK-004 storage is unavailable when endpoint is absent or fails", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/storage", (route) => route.fulfill({ status: 404, json: { error: "missing" } }));
  await page.goto("/#storage");
  await expect(page.getByRole("alert")).toContainText("Storage unavailable");
  await expect(page.getByText("Never synced")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Sync eligible metadata/ })).toBeDisabled();
  await page.route("**/api/storage", (route) => route.fulfill({ status: 503, json: { error: "offline" } }));
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("alert")).toContainText("503");
  await page.route("**/api/storage", (route) => route.fulfill({ json: {} }));
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("alert")).toContainText("Storage state unavailable");
  await expect(page.getByRole("button", { name: /Sync eligible metadata/ })).toBeDisabled();
});

test("UI-TASK-004 keeps sync receipts separate from connectivity and sends explicit per-environment requests", async ({ page }) => {
  await mockApi(page);
  const requests: Array<{ path: string; body: unknown }> = [];
  let checked = false;
  const storage = { environments: {
    development: { configuration: { configured: true, destination: { host: "dev.example", database: "db" }, error: null }, connectionString: "postgresql://user:secret@dev.example/db?token=hidden", pendingLocalChanges: true, lastSuccess: null, lastConnectivityCheck: null, latestFailedAttempt: null },
    production: { configuration: { configured: true, destination: { host: "prod.example", database: "prod" }, error: null }, pendingLocalChanges: true, lastSuccess: { at: "2026-01-01T00:00:00Z", counts: { runs: 3, lessons: 0 } }, lastConnectivityCheck: { at: "2026-02-01T00:00:00Z", ok: false, error: "timeout" }, latestFailedAttempt: { at: "2026-02-01T00:00:00Z", error: "timeout" } },
  } };
  await page.route(/\/api\/storage(?:\/.*)?$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") return route.fulfill({ json: { ...storage, environments: { ...storage.environments, development: { ...storage.environments.development, ...(checked ? { lastConnectivityCheck: { at: "2026-03-01T00:00:00Z", ok: true, tables: { shared_runs: { present: true, count: 3 }, shared_attempts: { present: false, count: null } } } } : {}) } } } });
    requests.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith("/diagnose")) checked = true;
    return route.fulfill({ json: {} });
  });
  await page.goto("/#storage");
  await expect(page.getByText("Never synced")).toBeVisible();
  await expect(page.locator(".storage-view")).toContainText("dev.example/db");
  await expect(page.locator(".storage-view")).not.toContainText("secret");
  await expect(page.locator(".storage-view")).not.toContainText("hidden");
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Check development connection" }).click();
  await expect(page.locator(".storage-receipts")).toContainText("2026-03-01T00:00:00Z");
  await expect(page.getByText("Never synced")).toBeVisible();
  await expect(page.getByRole("table", { name: "Diagnostic tables" })).toContainText("shared_runs");
  await expect(page.getByRole("table", { name: "Diagnostic tables" })).toContainText("Missing");
  expect(requests).toEqual([{ path: "/api/storage/diagnose", body: { environment: "development" } }]);
  await page.getByLabel("Destination environment").selectOption("production");
  await expect(page.locator(".storage-receipts")).toContainText("2026-01-01T00:00:00Z");
  await expect(page.locator(".storage-receipts")).toContainText("2026-02-01T00:00:00Z");
  await expect(page.locator(".storage-receipts")).toContainText("timeout");
  await expect(page.locator(".storage-view")).toContainText("Pending local changes: Yes");
  await expect(page.getByRole("status")).toContainText("Local changes are pending after this sync receipt");
  await page.getByRole("button", { name: "Sync eligible metadata to production" }).click();
  expect(requests).toEqual([{ path: "/api/storage/diagnose", body: { environment: "development" } }, { path: "/api/storage/sync", body: { environment: "production" } }]);
});

test("UI-TASK-004 failed sync preserves the previous receipt and shows the latest failure", async ({ page }) => {
  await mockApi(page);
  let failed = false;
  await page.route(/\/api\/storage(?:\/.*)?$/, (route) => {
    if (route.request().method() === "POST") { failed = true; return route.fulfill({ json: { operation: { action: "sync", ok: false }, latestFailedAttempt: { error: "Destination unavailable" } } }); }
    return route.fulfill({ json: { environments: { development: { configuration: { configured: true, destination: { host: "dev.example", database: "db" }, error: null }, pendingLocalChanges: true, lastSuccess: { at: "2026-01-01T00:00:00Z" }, latestFailedAttempt: failed ? { at: "2026-03-01T00:00:00Z", error: "Destination unavailable" } : null }, production: { ...unconfiguredStorage } } } });
  });
  await page.goto("/#storage");
  await page.getByRole("button", { name: "Sync eligible metadata to development" }).click();
  await expect(page.getByRole("alert")).toContainText("Destination unavailable");
  await expect(page.locator(".storage-receipts")).toContainText("2026-01-01T00:00:00Z");
  await expect(page.locator(".storage-receipts")).toContainText("2026-03-01T00:00:00Z");
  await expect(page.locator(".storage-view")).toContainText("Pending local changes: Yes");
});

test("UI-TASK-004 worker verification reason remains awaiting review", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/workflow", (route) => route.fulfill({ json: { revision: 1, base: null, capacity: { availability: "unknown" }, worktrees: { workers: { "TASK-001": { branch: "orch/task-001", path: "/fixture/worktree", base: "abc", validation: { passed: false, reason: "Manual review pending" } } }, integrations: {} }, policy: { version: 1, routing: { limits: {}, rules: {} }, history: [] }, runs: {} } }));
  await page.goto("/#workflow");
  await expect(page.getByRole("heading", { name: "Worktree review" }).locator("..")).toContainText("awaiting review: Manual review pending");
  await expect(page.getByRole("heading", { name: "Worktree review" }).locator("..")).not.toContainText("failed validation");
});

for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
  for (const theme of ["light", "dark"] as const) {
    test(`UI-TASK-005 ${size} ${theme} primary screens have no errors or page overflow`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mockApi(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto("/#overview");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#main-content")).toBeFocused();
      if (theme === "dark") await page.getByRole("button", { name: "Switch to dark theme" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      const screens = [
        { name: "Overview", hash: "#overview", heading: "Overview", evidence: "Current project plan" },
        { name: "Plan", hash: "#planning", heading: "AI planning draft", evidence: "Start from a goal" },
        { name: "Runs", hash: "#workflow", heading: "Runs and routing", evidence: "Timeline replay" },
        { name: "Knowledge", hash: "#knowledge", heading: "Knowledge", evidence: "Reviewed lessons" },
        { name: "Storage", hash: "#storage", heading: "Storage", evidence: "Shared metadata boundary" },
      ];
      for (const screen of screens) {
        await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: screen.name, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${screen.hash}$`));
        await expect(page.getByRole("heading", { name: screen.heading, exact: true }).first()).toBeVisible();
        await expect(page.getByText(screen.evidence, { exact: true }).first()).toBeVisible();
        if (screen.name === "Overview") await expect(page.locator(".overview-tasks")).toContainText("Visual check task 1");
        if (screen.name === "Plan") await expect(page.getByText("Check set revision 1:", { exact: false })).toBeVisible();
        if (screen.name === "Runs") await expect(page.getByRole("heading", { name: "Provider capacity" }).locator("..")).toContainText("remaining quota unknown");
        if (screen.name === "Knowledge") await expect(page.locator(".knowledge-list").first()).toContainText("reviewed-1");
        if (screen.name === "Storage") await expect(page.locator(".storage-view")).toContainText("dev.example/orch");
        await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: screen.name, exact: true })).toHaveAttribute("aria-current", "page");
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        expect(errors, `${screen.name} ${size} ${theme} browser errors`).toEqual([]);
        await capture(page, testInfo, `UI-TASK-005-${size}-${theme}-${screen.name.toLowerCase()}`);
      }
      await expect(page.locator(".storage-view")).toContainText("Never synced");
    });
  }
}

test("UI-TASK-005 empty, offline, and stopped worker states stay explicit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, true);
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "No goal recorded yet" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Runs" }).click();
  await expect(page.getByRole("heading", { name: "No runs yet" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Storage" }).click();
  await page.route("**/api/storage", (route) => route.fulfill({ status: 503, json: { error: "offline" } }));
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("alert")).toContainText("Storage unavailable");
  await expect(page.getByRole("button", { name: /Sync eligible metadata/ })).toBeDisabled();
  await page.route("**/api/commands", (route) => route.fulfill({ json: {
    revision: 3, plan: { revision: 2, value: { draft: { goal: "Complete fixture work", status: "review", questions: [], answers: {}, tasks: [] } } }, checksRevision: 1,
    approvals: { plan: { value: { target: "plan", targetRevision: 2 } }, checks: { value: { target: "checks", targetRevision: 1 } } },
  } }));
  await page.route("**/api/tasks", (route) => route.fulfill({ json: { tasks: tasks.map((task, index) => ({ ...task, status: index === 0 ? "running" : "pending", displayStatus: index === 0 ? "running" : "blocked" })) } }));
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Inspect possibly interrupted work" })).toBeVisible();
  await expect(page.locator(".next-action")).toContainText("before retrying");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("UI-TASK-004 active CLI liveness and explicit recovery choice reach the API", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/commands", route => route.fulfill({ json: { revision: 3, plan: { revision: 2, value: { draft: { goal: "Recovery", status: "review", questions: [], answers: {}, tasks: [] } } }, checksRevision: 1, approvals: { plan: { value: { target: "plan", targetRevision: 2 } }, checks: { value: { target: "checks", targetRevision: 1 } } } } }));
  const workflow = { revision: 1, base: null, capacity: { availability: "unknown" }, worktrees: { workers: { "TASK-001": { branch: "orch/task-001", path: "/fixture/worker", base: "abc", validation: { passed: true }, verification: { passed: false, reason: "Review required" } } }, integrations: {} }, policy: { version: 1, routing: { limits: {}, rules: {} }, history: [] }, runs: {}, jobs: [], runtime: { liveness: "active" } };
  await page.route("**/api/workflow", route => route.fulfill({ json: workflow }));
  await page.route("**/api/tasks", route => route.fulfill({ json: { tasks: tasks.map((task, index) => ({ ...task, status: index === 0 ? "running" : "pending", displayStatus: index === 0 ? "running" : "blocked" })) } }));
  await page.goto("/#overview");
  await expect(page.getByRole("heading", { name: "Inspect running work" })).toBeVisible();
  await expect(page.locator(".goal-card")).toContainText("Plan approved");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Runs" }).click();
  await page.getByText("Advanced worker and routing view").click();
  await page.getByLabel("Task ID to retry").fill("TASK-001");
  await expect(page.getByRole("button", { name: "Retry inspected task" })).toBeDisabled();
  await page.getByLabel("Worker changes").selectOption("preserve");
  let submitted: unknown;
  await page.route("**/api/commands", async route => { submitted = route.request().postDataJSON(); await route.fulfill({ json: { revision: 4 } }); });
  await page.getByRole("button", { name: "Retry inspected task" }).click();
  await expect.poll(() => submitted).toMatchObject({ kind: "plan.retry", payload: { taskId: "TASK-001", reconciliation: "preserve" } });
  await expect(page.locator("#worktree-review")).toContainText("awaiting review: Review required");
});
