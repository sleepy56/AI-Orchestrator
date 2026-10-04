import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveCodexLaunch, runCodex } from "./providers";

test("Windows Codex launcher finds the npm CLI when no executable is on PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orch-codex-"));
  try {
    const entryPoint = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    await mkdir(join(directory, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    await writeFile(join(directory, "codex.cmd"), "npm shim");
    await writeFile(entryPoint, "console.log('ready')");
    assert.deepEqual(await resolveCodexLaunch(directory, "win32"), {
      command: process.execPath,
      argsPrefix: [entryPoint],
    });
    assert.deepEqual(await resolveCodexLaunch([directory, "missing"].join(delimiter), "win32"), {
      command: process.execPath,
      argsPrefix: [entryPoint],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex JSONL progress, final response, and usage are captured", async () => {
  const events: string[] = [];
  const script = [
    'console.log(JSON.stringify({type:"thread.started",thread_id:"thread-1"}))',
    'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"READY"}}))',
    'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:12,output_tokens:3}}))',
  ].join(";");
  const result = await runCodex(process.execPath, ["-e", script], tmpdir(), 3000, (event) => events.push(event));
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.finalResponse, "READY");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 3);
  assert.ok(events.includes("thread.started"));
  assert.ok(events.includes("item.completed: agent_message"));
});

test("a stalled Codex subprocess is stopped by the timeout", async () => {
  const result = await runCodex(process.execPath, ["-e", "setInterval(() => {}, 1000)"], tmpdir(), 200);
  assert.equal(result.timedOut, true);
});

test("Codex output keeps an active task alive past the idle timeout", async () => {
  const script = [
    'let count=0',
    'const ticker=setInterval(()=>{console.log(JSON.stringify({type:"turn.started"}));if(++count===12){clearInterval(ticker);process.exit(0)}},80)',
  ].join(";");
  const result = await runCodex(process.execPath, ["-e", script], tmpdir(), 600);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("Codex subprocess receives EOF on stdin instead of waiting for extra input", async () => {
  const script = 'process.stdin.on("end",()=>console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"READY"}})));process.stdin.resume()';
  const result = await runCodex(process.execPath, ["-e", script], tmpdir(), 3000);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.finalResponse, "READY");
});
