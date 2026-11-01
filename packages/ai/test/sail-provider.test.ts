import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { sailProvider } from "../src/providers/sail.ts";

const upstreamId = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

describe("Sail models", () => {
	it("registers DeepSeek V4.1 Flash 1017 via the Responses API on ASAP", () => {
		const model = getModel("sail", upstreamId);

		expect(model.name).toBe("DeepSeek V4.1 Flash 1017");
		expect(model.api).toBe("openai-responses");
		expect(model.provider).toBe("sail");
		expect(model.baseUrl).toBe("https://api.sailresearch.com/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(32768);
		expect(model.headers).toEqual({ "X-Sail-Completion-Window": "asap" });
		expect(model.cost).toEqual({ input: 0.09, output: 0.3, cacheRead: 0.006, cacheWrite: 0 });
		expect(model.compat?.supportsLongCacheRetention).toBe(false);
	});

	it("keeps Balanced under Sail with its own completion window and pricing", () => {
		const model = getModel("sail", `${upstreamId}-balanced`);

		expect(model.name).toBe("DeepSeek V4.1 Flash 1017 Balanced");
		expect(model.provider).toBe("sail");
		expect(model.headers).toEqual({ "X-Sail-Completion-Window": "balanced" });
		expect(model.cost).toEqual({ input: 0.07, output: 0.22, cacheRead: 0.005, cacheWrite: 0 });
	});

	it("resolves the stored API key without an environment fallback", async () => {
		const auth = sailProvider().auth!.apiKey!;
		const options = {
			ctx: { env: async () => "unused-env-key", fileExists: async () => false },
			signal: new AbortController().signal,
		};

		expect(await auth.resolve(options)).toBeUndefined();
		expect(await auth.resolve({ ...options, credential: { type: "api_key", key: "test-sail-key" } })).toMatchObject({
			auth: { apiKey: "test-sail-key" },
		});
	});

	it.each([upstreamId, `${upstreamId}-balanced`] as const)("sends the upstream model ID for %s", async (modelId) => {
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			getModel("sail", modelId),
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-sail-key",
				cacheRetention: "long",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload).toMatchObject({ model: upstreamId });
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});
});
