# Async, balanced compaction on Sail + Pi Durable

## Durable coding agent

A headless coding agent on Durable. Pi supplies settings, credentials, models, and the system prompt;
Durable supplies SQLite persistence and the `read`, `write`, `edit`, and `bash` tools.

- `main.ts`: arguments, event log, signals; open, run, close.
- `runtime.ts`: Pi services, model selection, Harness, and cleanup.
- `sessions.ts`: session directories and the process lock.
- `prompt.ts`: Pi's prompt with Durable's tool descriptions.
- `print.ts`: submission, committed events, timing, and usage after background work finishes.
