// Sail's default and Balanced variants share upstream weights and use different completion windows.
import type { Model } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

// https://docs.sailresearch.com/models and https://docs.sailresearch.com/pricing
export default defineProvider({
	id: "sail",
	models: () => {
		const model: Model<"openai-responses"> = {
			id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
			name: "DeepSeek V4.1 Flash 1017",
			api: "openai-responses",
			provider: "sail",
			baseUrl: "https://api.sailresearch.com/v1",
			headers: { "X-Sail-Completion-Window": "asap" },
			reasoning: true,
			input: ["text"],
			contextWindow: 1000000,
			// shortcut: cap output at 32K until Sail publishes a model-specific output limit.
			maxTokens: 32768,
			promptCache: { short: 1800 },
			cost: { input: 0.09, output: 0.3, cacheRead: 0.006, cacheWrite: 0 },
		};
		return [
			model,
			{
				...model,
				id: `${model.id}-balanced`,
				name: `${model.name} Balanced`,
				headers: { "X-Sail-Completion-Window": "balanced" },
				// Keep the variant's identity in Pi while sending Sail the actual upstream model ID.
				samplingParams: { model: model.id },
				cost: { input: 0.07, output: 0.22, cacheRead: 0.005, cacheWrite: 0 },
			},
		];
	},
	compat: { "openai-responses": { supportsLongCacheRetention: false } },
});
