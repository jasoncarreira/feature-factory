---
description: Durable feature-factory workflow with story, research, spec, decomposition, build, tests, validation, and PR gates.
agent: feature-factory
---

# /feature

Use the `feature` skill for this run. If it is not loaded, call the skill tool with `name: feature` before continuing.

Initial request: $ARGUMENTS

Run as the main orchestrator, not as a subagent. Before creating or changing any run state, classify the request with the intent gate from the `feature` skill.

Only after intent classification should you create todos, persist state on disk, route work through specialized feature-factory agents, or stop at gates.

Do not start implementation unless the durable manifest shows the story and technical-brief gates are already approved.
