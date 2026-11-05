// Open and close a Durable conversation with Pi's configuration and a session lock.
import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getAgentDir } from "../../config.ts";
import { createAgentSessionServices } from "../../core/agent-session-services.ts";
import { getClientIdentity } from "../../core/client-identity.ts";
import { DEFAULT_THINKING_LEVEL } from "../../core/defaults.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { findInitialModel, resolveCliModel } from "../../core/model-resolver.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createCodingRegistry } from "./prompt.ts";
import { openSession, type SessionTarget } from "./sessions.ts";

export interface DurableOptions {
	cwd: string;
	session: SessionTarget;
	provider?: string;
	model?: string;
	thinkingLevel?: ModelThinkingLevel;
	backgroundCompaction: "normal" | "async";
	backgroundTokens?: number;
	blockingCompaction?: boolean;
}

export type DurableRuntime = Awaited<ReturnType<typeof openDurable>>;

/** Open a configured session without starting recovered work; close releases all owned resources. */
export async function openDurable(options: DurableOptions, context: Context) {
	const location = await openSession(options.cwd, options.session);
	const env = new NodeExecutionEnv({ cwd: location.cwd });
	let harness: Harness | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			try {
				await harness?.close(context);
			} finally {
				try {
					await env.cleanup(context);
				} finally {
					await location.release();
				}
			}
		})();
		return closing;
	};
	try {
		const agentDir = getAgentDir();
		const settings = SettingsManager.create(location.cwd, agentDir);
		applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
		configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
		const { modelRuntime: models, resourceLoader: resources } = await createAgentSessionServices({
			cwd: location.cwd,
			agentDir,
			settingsManager: settings,
			resourceLoaderOptions: { noExtensions: true, noThemes: true },
		});
		harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models,
				registry: createCodingRegistry(location.cwd, resources),
				env: () => env,
				identity: getClientIdentity(settings),
				settings: () => {
					const providerRetry = settings.getProviderRetrySettings();
					return {
						stream: {
							...providerRetry,
							timeoutMs: providerRetry.timeoutMs ?? (settings.getHttpIdleTimeoutMs() || 2147483647),
							transport: settings.getTransport(),
						},
						retry: settings.getRetrySettings(),
						steeringMode: settings.getSteeringMode(),
						followUpMode: settings.getFollowUpMode(),
						compaction: {
							...settings.getCompactionSettings(),
							blocking: options.blockingCompaction,
							modelOverrides: settings.getSettings().compaction?.modelOverrides,
							...(options.backgroundTokens === undefined ? {} : { backgroundTokens: options.backgroundTokens }),
							background:
								options.backgroundCompaction === "async" ? { kind: "async-background" as const } : undefined,
						},
					};
				},
				onReport: ({ error }) => console.error(error),
			},
			context,
		);
		const root = await harness.root(context, { agent: { cwd: location.cwd } });
		const saved = await harness.snapshot(AgentDoc, root.id, context);
		const resolved = options.model
			? resolveCliModel({ cliProvider: options.provider, cliModel: options.model, modelRuntime: models })
			: saved?.model
				? { model: models.getModel(saved.model.provider, saved.model.modelId), thinkingLevel: saved.thinkingLevel }
				: await findInitialModel({
						scopedModels: [],
						isContinuing: false,
						defaultProvider: settings.getDefaultProvider(),
						defaultModelId: settings.getDefaultModel(),
						defaultThinkingLevel: settings.getDefaultThinkingLevel(),
						modelThinkingLevels: settings.getAllModelThinkingLevels(),
						modelRuntime: models,
					});
		if ("error" in resolved && resolved.error) throw new Error(resolved.error);
		const { model } = resolved;
		if (!model) throw new Error("No model available; configure Pi's model and credentials first");
		await root.configure(
			{
				model: { provider: model.provider, modelId: model.id },
				thinkingLevel: clampThinkingLevel(
					model,
					options.thinkingLevel ??
						resolved.thinkingLevel ??
						saved?.thinkingLevel ??
						settings.getModelThinkingLevel(model.provider, model.id) ??
						settings.getDefaultThinkingLevel() ??
						DEFAULT_THINKING_LEVEL,
				),
			},
			context,
		);
		return {
			harness,
			root,
			context,
			database: location.database,
			directory: location.directory,
			backgroundCompaction: options.backgroundCompaction,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
