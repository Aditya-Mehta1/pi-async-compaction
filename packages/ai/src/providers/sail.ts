// Sail uses Pi's standard stored API-key login and OpenAI Responses transport.
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { SAIL_MODELS } from "./sail.models.ts";

/** Create Sail with its default low-latency and Balanced model variants. */
export function sailProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "sail",
		name: "Sail",
		baseUrl: "https://api.sailresearch.com/v1",
		auth: { apiKey: envApiKeyAuth("Sail API key", []) },
		models: Object.values(SAIL_MODELS),
		api: openAIResponsesApi(),
	});
}
