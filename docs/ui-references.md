# Open source UI references

Study these interfaces for interaction patterns, then design Orch around its own task graph, validation evidence, and routing history.

| Reference | Useful pattern for Orch | What Orch should make clearer |
| --- | --- | --- |
| [Langflow](https://github.com/langflow-ai/langflow) | Visual workflow builder, step-by-step playground, reusable node and edge interaction | Separate the editable plan from the live execution graph and show why a route was chosen |
| [AutoGen Studio](https://github.com/microsoft/autogen/tree/main/python/packages/autogen-studio) | Agent and skill composition, workflow prototyping, session views | Put validated task outcomes and policy revisions beside agent messages; its README calls it a prototype, so use it as an interaction reference |
| [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) | Local control center for coding agents, backend switching, conversation and automation views | Show model effort, task dependencies, check results, and cross-run learning in one place |
| [Flowise](https://github.com/FlowiseAI/Flowise) | Historical reference for a large visual agent-flow canvas | Its main repository was archived in August 2026; use it for design study rather than as a dependency |

## Reference review checklist

1. Capture how each app handles an empty project, a running agent, a failed step, and a completed run.
2. Compare graph readability at 4, 20, and 100 tasks. Check panning, zooming, grouping, and keyboard navigation.
3. Inspect how a user reaches the exact output and validation evidence from a node.
4. Sketch the Orch Overview and Run detail views using real event data, including one failed task and one escalation.
5. Keep the initial UI read-only until run history, task state, and route decisions have stable IDs and durable storage.

The goal is a clear supervision interface, not a general drag-and-drop agent builder. The user should be able to answer: “What is running?”, “Why that model?”, “What changed?”, and “What evidence says it passed?”
