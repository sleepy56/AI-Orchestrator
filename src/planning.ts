import { CommandResult, CommandService, DraftTask, PlanningQuestion } from "./command-service";
import { resolveCodexLaunch, runCodex } from "./providers";

export interface PlanningModel {
  propose(input: { goal: string; answers?: Record<string, string>; documents: string[]; scripts: Record<string, string> }): Promise<unknown>;
}

function jsonReply(output: string): unknown {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); }
  catch { throw new Error("Planner did not return valid JSON; no draft was saved"); }
}

export class CodexPlanningModel implements PlanningModel {
  constructor(private readonly project: string) {}
  async propose(input: { goal: string; answers?: Record<string, string>; documents: string[]; scripts: Record<string, string> }): Promise<unknown> {
    const launch = await resolveCodexLaunch();
    const prompt = [
      "You are drafting an Orch development plan. Inspect the repository read-only, including its instructions and listed context documents.",
      `Goal: ${input.goal}`,
      `Context documents: ${JSON.stringify(input.documents)}. Available scripts: ${JSON.stringify(input.scripts)}.`,
      input.answers ? `Answers to earlier questions: ${JSON.stringify(input.answers)}. Do not ask further questions; use reasonable assumptions and draft now.` : "Ask at most three questions only if different answers would materially change task scope, dependencies, risk, or acceptance criteria. Each question must explain that impact. If a safe assumption suffices, draft now.",
      "Return only JSON with keys questions and tasks. questions is an array of {id,question,impact}. If questions are needed, tasks must be []. Otherwise questions must be [] and tasks is a nonempty array.",
      "Each task: {id,description,type,difficulty,risk,dependsOn,acceptanceCriteria,areas,workerProfile,context,verification}. IDs are unique TASK-NNN. Dependencies refer only to tasks in this draft and form an acyclic graph. type: rename|refactor|analysis|test|other; difficulty: easy|moderate|hard|extreme; risk: low|medium|high|critical. acceptanceCriteria, areas, context, verification are nonempty arrays of concrete strings. workerProfile is a proposed model/effort, not an assignment.",
      "Give one verification entry per acceptance criterion in the same order. For behavior that can be tested, use 'command: <focused test command>' and name the behavior the test must assert. If a new test is needed, add testArtifacts: [{name,content}] to that task and refer to it as {{test:name}} in its command, for example 'command: node --test {{test:export.test.js}}'. Write assertions against actual project behavior, not placeholders or always-passing tests. Generated test files are saved under .orch/generated-tests at a plan-revision path for review. For visual or judgment criteria, use 'review: <concrete review procedure>'. Never claim a broad build proves an unrelated behavior.",
      "Use only read-only file inspection and searches. Do not run builds, tests, installs, deployments, or workers, and do not modify files. Keep the plan limited to the goal.",
    ].join("\n");
    const result = await runCodex(launch.command, [...launch.argsPrefix, "exec", "--json", "--ephemeral", "--sandbox", "read-only", "-C", this.project, prompt], this.project, 120_000);
    if (result.timedOut || result.exitCode !== 0) throw new Error(`Planner failed: ${result.stderr || "no response"}`);
    return jsonReply(result.finalResponse);
  }
}

function proposal(value: unknown): { questions: PlanningQuestion[]; tasks: DraftTask[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Planner response needs an object");
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.questions) || !Array.isArray(result.tasks)) throw new Error("Planner response needs questions and tasks arrays");
  return { questions: result.questions as PlanningQuestion[], tasks: result.tasks as DraftTask[] };
}

export class PlanningWorkflow {
  private readonly commands: CommandService;
  constructor(private readonly project: string, private readonly model: PlanningModel = new CodexPlanningModel(project)) { this.commands = new CommandService(project); }

  async start(goal: string): Promise<CommandResult> {
    if (typeof goal !== "string" || !goal.trim()) throw new Error("Goal needs text");
    const state = await this.commands.detail();
    const plan = proposal(await this.model.propose({ goal, documents: state.project.value.context?.documents ?? [], scripts: state.project.value.scripts ?? {} }));
    return this.commands.execute({ version: 1, kind: "plan.goal", expectedRevision: state.revision, payload: { goal, ...plan } });
  }

  async answer(answers: Record<string, string>, expectedRevision: number): Promise<CommandResult> {
    const state = await this.commands.detail();
    if (state.revision !== expectedRevision) throw new Error(`Stale revision: expected ${expectedRevision}, current ${state.revision}`);
    const draft = state.plan.value.draft;
    if (!draft || draft.status !== "clarifying") throw new Error("No questions await answers");
    if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).length !== draft.questions.length || draft.questions.some((question) => typeof answers[question.id] !== "string" || !answers[question.id].trim())) throw new Error("Answer every planning question");
    const plan = proposal(await this.model.propose({ goal: draft.goal, answers, documents: state.project.value.context?.documents ?? [], scripts: state.project.value.scripts ?? {} }));
    if (plan.questions.length) throw new Error("Planner asked another question; no draft was saved");
    return this.commands.execute({ version: 1, kind: "plan.answer", expectedRevision, payload: { answers, tasks: plan.tasks } });
  }
}
