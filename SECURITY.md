# Security Policy

agent-state records agent activity locally and redacts secrets before writing anything to disk. If you find a way secrets can be persisted or sent anywhere unexpectedly, or a way restore can destroy user work, please report it privately.

**Report:** open a [private security advisory](https://github.com/Alejovar/agent-state/security/advisories/new). Please don't file a public issue.

In scope:
- secrets reaching `.agent-state/` unredacted
- repository data being sent to an AI provider without explicit configuration
- restore/checkpoint operations that lose uncommitted work
- hook behavior that lets a malicious repository run code via agent-state

Supported versions: the latest minor release.
