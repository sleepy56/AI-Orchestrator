const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const Module = require("node:module");
const { join } = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = join(__dirname, "..", "src", "evidence.ts");
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics, []);
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = module.paths;
loaded._compile(compiled.outputText, sourcePath);
const { realModelAttempts, summarize, formatTokens, formatLatency } = loaded.exports;

const model = { alias: "sol-medium", provider: "codex", model: "gpt-6-sol", tier: "sol-medium" };
const attempt = (overrides) => ({
  kind: "attempt", at: "2026-01-01T00:00:00Z", taskId: "TASK-001", taskType: "other",
  difficulty: "moderate", risk: "medium", route: "sol-medium", model: "codex:gpt-6-sol",
  passed: true, errors: [], simulated: false, ...overrides,
});

test("model evidence excludes simulated and unattributed attempts", () => {
  const history = [
    attempt({ inputTokens: 10, outputTokens: 5, latencyMs: 1000 }),
    attempt({ passed: false, inputTokens: 20, outputTokens: 5, latencyMs: 3000 }),
    attempt({ simulated: true, passed: true }),
    attempt({ model: undefined, passed: false }),
    attempt({ route: "sol-high", passed: false }),
  ];
  const real = realModelAttempts(history, model);
  const summary = summarize(real);
  assert.equal(real.length, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.repeatedAttempts, 1);
  assert.equal(formatTokens(summary), "40 (2/2 recorded)");
  assert.equal(formatLatency(summary), "2.0s (2/2 recorded)");
});

test("missing usage and latency stay unknown instead of becoming zero", () => {
  const summary = summarize([attempt({ taskId: "TASK-002", inputTokens: 10 })]);
  assert.equal(summary.tokenSamples, 0);
  assert.equal(formatTokens(summary), "Unknown");
  assert.equal(formatLatency(summary), "Unknown");
});
