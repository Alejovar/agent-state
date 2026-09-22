---
description: Detect contradictions between docs/CLAUDE.md and the code
argument-hint: [path]
allowed-tools: Bash(agent-state:*)
---

!`agent-state drift $ARGUMENTS`

Summarize the drift findings. Never rewrite documentation without the user's approval.
