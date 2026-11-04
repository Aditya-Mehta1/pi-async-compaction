# Async, balanced compaction on Sail + Pi Durable

> Done properly, compaction should be cheap and near instant
>
> — [Jediah Katz on X](https://x.com/jediahkatz/status/2116307783075139912)

This makes sense, compaction should be instant because - if we are continously compacting, we don't need to wait for the context window filling up to compact.
We can simply kick off compaction **async, before** while generation is still happening.

Since this workflow is async, we can run it at balanced latency (= lower costs), ~for free<sup>*</sup>

This demo implements _async_ compaction (running during generation ie) on _Sail balanced_ inference: to get TODO: insert numbers cheaper compaction without impacting performance.

<sub>* for free here since if we are working at a lower <em>effective</em> context window of a model (ie << the total possible a API allows, eg 200 or 500k for a 1mn context model) we only compact when we chose to. We wait for the current turn generation / model response to complete and tools to run before changing the prompt with the summary (appending the uncompacted turns to the summary) </sub>

### Durable coding agent

A headless coding agent on Pi Durable. 

- `main.ts`: arguments, event log, signals; open, run, close.
- `runtime.ts`: Pi services, model selection, Harness, and cleanup.
- `sessions.ts`: session directories and the process lock.
- `prompt.ts`: Pi's prompt with Durable's tool descriptions.
- `print.ts`: submission, committed events, timing, and usage after background work finishes.
