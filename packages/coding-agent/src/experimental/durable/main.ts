#!/usr/bin/env node
// Headless Durable coding agent using Pi's configuration and credentials.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { runPrint } from "./print.ts";
import { openDurable } from "./runtime.ts";

const { values } = parseArgs({
	options: {
		continue: { type: "boolean", short: "c" },
		"prompt-file": { type: "string" },
		"output-dir": { type: "string" },
		provider: { type: "string" },
		model: { type: "string" },
		thinking: { type: "string" },
		"background-compaction": { type: "string", default: "normal" },
		"background-tokens": { type: "string" },
	},
});
if (!values["prompt-file"]) throw new Error("--prompt-file is required");
if (values.provider && !values.model) throw new Error("--provider requires --model");
if (values.continue && values["output-dir"]) throw new Error("Use --continue or --output-dir, not both");
const backgroundCompaction = values["background-compaction"];
if (backgroundCompaction !== "normal" && backgroundCompaction !== "async")
	throw new Error("--background-compaction must be normal or async");
if (values.thinking !== undefined && !isValidThinkingLevel(values.thinking))
	throw new Error(`Invalid thinking level: ${values.thinking}`);
const backgroundTokens = values["background-tokens"] === undefined ? undefined : Number(values["background-tokens"]);
if (backgroundTokens !== undefined && (!Number.isSafeInteger(backgroundTokens) || backgroundTokens < 0))
	throw new Error("--background-tokens must be an integer >= 0");
const prompt = readFileSync(values["prompt-file"], "utf8");
const runtime = await openDurable(
	{
		cwd: process.cwd(),
		session: values["output-dir"]
			? { kind: "directory", path: values["output-dir"] }
			: { kind: values.continue ? "continue" : "new" },
		provider: values.provider,
		model: values.model,
		thinkingLevel: values.thinking,
		backgroundCompaction,
		backgroundTokens,
	},
	BACKGROUND_CONTEXT,
);
const { promise: stopped, resolve: exit } = Promise.withResolvers<void>();
const stop = () => exit();
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
try {
	const events = join(runtime.directory, "events.jsonl");
	for (const signal of signals) process.on(signal, stop);
	const outcome = await Promise.race([
		runPrint(runtime, prompt, (event) => appendFileSync(events, `${JSON.stringify(event)}\n`)),
		stopped,
	]);
	if (outcome && outcome.status !== "done") {
		console.error(`Durable run ended without an answer: ${outcome.reason}`);
		process.exitCode = 1;
	}
} finally {
	for (const signal of signals) process.off(signal, stop);
	await runtime.close();
}
