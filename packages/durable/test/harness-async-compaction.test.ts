// Strategy-specific compaction behavior; shared lifecycle coverage lives in harness-compaction.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type CompactionCheckpoint,
	type CompactionResult,
	CompactionTask,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Storage,
	type TaskId,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { selectCut } from "../src/harness/compaction.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addHooks } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, type Deferred, deferred } from "./task-support.ts";

const balanced = { provider: "sail", modelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017-balanced" };
const usageKey = `${balanced.provider}/${balanced.modelId}`;
const policy = {
	background: { kind: "async-background" },
	reserveTokens: 500,
	keepRecentTokens: 150,
	backgroundTokens: 1000,
} as const;
const harnesses: Harness[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function open(storage: Storage = new MemoryStorage()) {
	const setup = {
		...chatSetup({ models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 900 }] }),
		models: createModels(),
	};
	setup.models.setProvider(setup.faux.provider);
	const sail = fauxProvider({ provider: "sail", models: [{ id: balanced.modelId, maxTokens: 300 }] });
	setup.models.setProvider({
		...sail.provider,
		getModels: () => [{ ...sail.getModel(), headers: { "X-Sail-Completion-Window": "balanced" } }],
		auth: { apiKey: { name: "Sail", resolve: async () => ({ auth: { apiKey: "sail-test-key" } }) } },
	});
	setup.settings.compaction = { ...policy, enabled: false };
	setup.settings.stream = { cacheRetention: "none" };
	setup.settings.retry = { enabled: false };
	const chat = await openChat(storage, setup);
	harnesses.push(chat.harness);
	for (let index = 0; index < 3; index++) {
		setup.faux.appendResponses([fauxAssistantMessage("a".repeat(400))]);
		const input = await chat.root.submit({ type: "input", content: `u${index} ${"x".repeat(400)}` }, context);
		expect((await input.wait(context)).status).toBe("done");
	}
	setup.settings.compaction = policy;
	return { ...chat, setup, sail };
}

type Chat = Awaited<ReturnType<typeof open>>;

function hold(sail: Chat["sail"], reply = fauxAssistantMessage("SUMMARY")) {
	const reached = deferred<SimpleStreamOptions | undefined>();
	const release = deferred();
	sail.appendResponses([
		async (_transcript, options) => {
			reached.resolve(options);
			await Promise.race([release.promise, aborted(options!.signal!)]);
			return reply;
		},
	]);
	return { reached: reached.promise, release: () => release.resolve() };
}

async function trigger(chat: Chat, gate?: Deferred) {
	chat.setup.faux.appendResponses([
		async (_transcript, options) => {
			if (gate !== undefined) await Promise.race([gate.promise, aborted(options!.signal!)]);
			return fauxAssistantMessage("answer");
		},
	]);
	return chat.root.submit({ type: "input", content: `next ${"x".repeat(400)}` }, context);
}

async function backgroundTask(chat: Chat): Promise<TaskId<CompactionResult>> {
	const live = await chat.harness.snapshot(LiveDoc, chat.root.id, context);
	return live!.compactions!.find((task) => !task.blocking)!.taskId;
}

describe("async background compaction", () => {
	it("uses foreground trigger/cut policy, inherited thinking, isolated auth and the summarizer output cap", async () => {
		const chat = await open();
		// Overrides belong to the foreground model; a Sail override must not change admission, cut or reserve.
		chat.setup.settings.compaction = {
			...policy,
			keepRecentTokens: 10000,
			modelOverrides: {
				"faux/faux-1": { keepRecentTokens: 150 },
				[usageKey]: { enabled: false, reserveTokens: 10 },
			},
		};
		await chat.root.configure({ thinkingLevel: "xhigh" }, context);
		chat.setup.settings.stream = {
			headers: { Authorization: "Bearer foreground", "X-Sail-Completion-Window": "asap" },
			transport: "websocket",
			metadata: { foreground: true },
			timeoutMs: 12345,
			maxRetries: 2,
			maxRetryDelayMs: 678,
		};
		const held = hold(chat.sail);
		const foreground = deferred();
		const input = await trigger(chat, foreground);
		const request = await held.reached;
		const id = await backgroundTask(chat);
		const view = await chat.root.context(context);
		const firstKept = view.entries[selectCut(view, 150)!]!.id;
		expect(await chat.harness.getTask(id, context)).toMatchObject({
			version: 2,
			background: true,
			input: { summarizer: balanced },
			state: { checkpoint: { model: balanced, thinkingLevel: "xhigh", firstKept, maxTokens: 300 } },
		});
		expect(request).toMatchObject({
			apiKey: "sail-test-key",
			headers: { "X-Sail-Completion-Window": "balanced" },
			reasoning: "xhigh",
			maxTokens: 300,
			timeoutMs: 12345,
			maxRetries: 2,
			maxRetryDelayMs: 678,
			cacheRetention: "none",
		});
		expect(request?.headers).toEqual({ "X-Sail-Completion-Window": "balanced" });
		expect(request?.transport).toBeUndefined();
		expect(request?.metadata).toBeUndefined();
		expect(request?.deferred).toBeUndefined();
		foreground.resolve();
		expect((await input.wait(context)).status).toBe("done");
		held.release();
		expect((await chat.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		expect((await chat.harness.snapshot(UsageDoc, chat.root.id, context))?.models[usageKey]?.output).toBeGreaterThan(
			0,
		);
	});

	it.each(["manual", "blocking"] as const)("keeps %s on the foreground model and options", async (mode) => {
		const chat = await open();
		chat.setup.settings.stream = { headers: { "X-Foreground": "kept" } };
		chat.setup.settings.compaction = { ...policy, reserveTokens: mode === "blocking" ? 1500 : 500 };
		const request = deferred<SimpleStreamOptions | undefined>();
		chat.setup.faux.appendResponses(
			Array.from({ length: 2 }, () => (transcript: TranscriptContext, options?: SimpleStreamOptions) => {
				if (transcript.messages[0]?.role === "system") request.resolve(options);
				return fauxAssistantMessage("foreground summary");
			}),
		);
		if (mode === "manual") await chat.root.compact(undefined, context);
		else await trigger(chat);
		expect(await request.promise).toMatchObject({ headers: { "X-Foreground": "kept" } });
		expect(chat.sail.state.callCount).toBe(0);
	});

	it.each(["select", "retry"] as const)("pins admission and request across recovery from %s", async (phase) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-async-compaction-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		const chat = await open(await openNodeSqliteStorage(path));
		await chat.root.configure({ thinkingLevel: "high" }, context);
		const selected = deferred();
		const hook = addHooks(chat.setup.registry, CompactionTask, {
			beforeCompact: async (_request, _api, ctx) => {
				if (phase !== "select") return;
				selected.resolve();
				await aborted(ctx.abortSignal!);
			},
		});
		chat.setup.settings.stream = { timeoutMs: 12345 };
		let now = Date.now();
		chat.setup.now = () => now;
		chat.setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 60000 };
		const held = hold(chat.sail, fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }));
		await (await trigger(chat)).wait(context);
		if (phase === "select") await selected.promise;
		else await held.reached;
		const id = await backgroundTask(chat);
		if (phase === "retry") {
			held.release();
			await waitFor(async () => (await chat.harness.getTask(id, context))?.state.status === "sleeping");
		}
		const before = await chat.harness.snapshot(UsageDoc, chat.root.id, context);
		expect(before?.models[usageKey] !== undefined).toBe(phase === "retry");
		const pinned = (await chat.harness.getTask(id, context))?.state;
		await chat.harness.close(context);
		hook.dispose();
		chat.setup.settings.compaction = { ...policy, background: undefined };
		chat.setup.settings.stream = { timeoutMs: 777 };
		now += 120000;
		const reopened = await openChat(await openNodeSqliteStorage(path), chat.setup);
		harnesses.push(reopened.harness);
		await reopened.root.configure({ thinkingLevel: "low" }, context);
		chat.sail.setResponses([]);
		const resent = hold(chat.sail);
		reopened.harness.resume();
		const request = await resent.reached;
		expect(request).toMatchObject({
			reasoning: phase === "select" ? "low" : "high",
			timeoutMs: phase === "select" ? 777 : 12345,
		});
		const task = await reopened.harness.getTask(id, context);
		expect(task?.input).toMatchObject({ summarizer: balanced });
		if (phase === "retry" && pinned?.status !== "terminal" && pinned !== undefined && "checkpoint" in pinned) {
			// getTask erases checkpoint types; this is the built-in compaction's stored request.
			const checkpoint = pinned.checkpoint as CompactionCheckpoint;
			if (checkpoint.phase === "select") throw new Error("Request was not pinned");
			expect(task?.state).toMatchObject({
				checkpoint: {
					model: checkpoint.model,
					thinkingLevel: checkpoint.thinkingLevel,
					streamOptions: checkpoint.streamOptions,
					maxTokens: checkpoint.maxTokens,
					firstKept: checkpoint.firstKept,
					tail: checkpoint.tail,
					phase: "summarize",
					attempt: 2,
				},
			});
		}
		resent.release();
		expect((await reopened.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		const usage = (await reopened.harness.snapshot(UsageDoc, reopened.root.id, context))!.models[usageKey]!;
		expect(usage.input).toBeGreaterThan(before?.models[usageKey]?.input ?? 0);
		expect(usage.output).toBe(2);
	});
});
