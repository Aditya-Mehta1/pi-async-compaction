// Headless execution with committed events, answer timing, and complete usage.
import { UsageDoc } from "@earendil-works/pi-durable";
import type { DurableRuntime } from "./runtime.ts";

/** Submit a prompt and report usage after background summaries finish. The caller owns closing. */
export async function runPrint(runtime: DurableRuntime, prompt: string, emit: (record: object) => void) {
	const { harness, root, context } = runtime;
	const { promise: failed, reject } = Promise.withResolvers<never>();
	const observation = harness.observeCommits({
		advance(publication) {
			try {
				for (const change of publication.changes) {
					if (change.type === "entry") emit({ type: "entry", entry: change.value });
					if (
						change.type === "document" &&
						change.kind === "change" &&
						change.record.kind === UsageDoc.definition.kind
					) {
						emit({ type: "usage", usage: change.value });
					}
				}
			} catch (error) {
				reject(error);
			}
		},
		end() {},
	});
	try {
		return await Promise.race([submitAndDrain(), failed]);
	} finally {
		observation.detach();
	}

	async function submitAndDrain() {
		emit({ type: "start", backgroundCompaction: runtime.backgroundCompaction, database: runtime.database });
		const started = performance.now();
		const outcome = await (await root.submit({ type: "input", content: prompt }, context)).wait(context);
		const answerMs = performance.now() - started;
		// Idle excludes background tasks; their charges and queued summaries must also commit.
		for (;;) {
			await harness.waitForIdle(context);
			const { tasks } = await harness.inspect(context);
			if (tasks.length === 0) break;
			await Promise.all(tasks.map(({ record }) => harness.waitForTask(record.id, context)));
		}
		emit({ type: "usage", usage: await harness.usage(context) });
		emit({ type: "end", outcome, answerMs, elapsedMs: performance.now() - started });
		return outcome;
	}
}
