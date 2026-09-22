---
description: Preview restoring a checkpoint (dry run; the user confirms the real restore)
argument-hint: <name>
allowed-tools: Bash(agent-state:*)
---

!`agent-state restore $ARGUMENTS --dry-run`

Summarize what restoring would change and the conflicts. Do NOT run the real restore yourself; tell the user to run `agent-state restore <name>` in their terminal.
