---
description: Save the task state so you can continue in a clean context with /clear
allowed-tools: Bash(agent-state:*)
---

!`agent-state compact`

Tell the user in one or two lines: the task state is saved, and typing /clear now starts a clean context that automatically receives just that state (better quality, fewer tokens than continuing this long conversation).
