import { Agent } from "@mariozechner/pi-agent-core";
import {
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai/openai-completions";
import type { Model } from "@mariozechner/pi-ai";
import type { App } from "obsidian";
import { resolveApiKey, type ObsidipiSettings } from "./settings";
import { readNoteTool } from "./vault-tools";

const PROVIDER_BASE_URLS: Record<ObsidipiSettings["provider"], string> = {
	deepseek: "https://api.deepseek.com",
	anthropic: "https://api.anthropic.com",
	google: "https://generativelanguage.googleapis.com",
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
};

export function buildModel(settings: ObsidipiSettings): Model<"openai-completions"> {
	return {
		id: settings.model,
		name: settings.model,
		api: "openai-completions",
		provider: settings.provider,
		baseUrl: PROVIDER_BASE_URLS[settings.provider],
		reasoning: settings.model.includes("reasoner"),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64000,
		maxTokens: 8192,
	};
}

export function createAgent(app: App, settings: ObsidipiSettings): Agent {
	return new Agent({
		initialState: {
			model: buildModel(settings),
			systemPrompt:
				"You are Obsidipi, an assistant inside an Obsidian vault on iOS. " +
				"You can read notes from the user's vault using the read_note tool. " +
				"Vault paths are relative and must include the .md extension. " +
				"Be concise.",
			tools: [readNoteTool(app)],
		},
		streamFn: streamSimpleOpenAICompletions,
		getApiKey: () => {
			const key = resolveApiKey(app, settings);
			return key ?? undefined;
		},
	});
}
