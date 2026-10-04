import { expect, test, type Page, type TestInfo } from "@playwright/test";

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
    if (url.pathname === "/api/tasks") body = { tasks: empty ? [] : tasks.map((task) => ({ ...task, displayStatus: task.spec.dependsOn.length ? "blocked" : "ready" })) };
    else if (url.pathname === "/api/models") body = { models: empty ? [] : models, policyVersion: 1 };
    else if (url.pathname === "/api/history") body = { attempts: empty ? [] : history };
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
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true, animations: "disabled" }), contentType: "image/png" });
}

async function seek(page: Page, sequence: number) {
  const slider = page.getByRole("slider", { name: /Event/ });
  await slider.focus();
  await slider.press("Home");
  for (let index = 1; index < sequence; index++) await slider.press("ArrowRight");
}

test("timeline replay changes graph, worker, and validation evidence without future state", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Timeline replay" })).toBeVisible();
  await expect(page.locator(".graph-node.failed")).toHaveCount(1);
  await expect(page.locator(".graph-node.failed")).toHaveCSS("border-left-color", "rgb(231, 123, 136)");
  await expect(page.locator(".graph-node.failed-descendant")).toHaveCount(4);
  await expect(page.getByText("Fixture validation failed").first()).toBeVisible();
  await capture(page, testInfo, "failed-run-overview");

  await seek(page, 3);
  await expect(page.locator(".graph-node.running")).toHaveCount(1);
  await expect(page.locator(".graph-node.running")).toHaveCSS("border-left-color", "rgb(88, 211, 228)");
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
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No runs yet" })).toBeVisible();
  await expect(page.locator(".timeline-panel")).toContainText("No run events recorded yet");
  await expect(page.locator(".graph-section")).toContainText("No tasks in this project yet");
  await expect(page.locator(".worker-section")).toContainText("No enabled workers are configured");
  await capture(page, testInfo, "empty-project");
});

test("dense graph and worker map remain readable and keyboard operable", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
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
  await expect(page.locator(":focus")).toHaveCount(1);
});

test("small viewport keeps timeline controls and selected evidence accessible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
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
