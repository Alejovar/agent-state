---
description: Write a handoff for the next session or another agent
argument-hint: [task-id]
allowed-tools: Bash(agent-state:*)
---

!`agent-state handoff $ARGUMENTS`

Show the handoff path to the user. If important decisions, open issues or the next step are missing, record them with `agent-state decide` / `agent-state note` and run /handoff again.
