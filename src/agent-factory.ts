import { Agent } from "@mariozechner/pi-agent-core";
import {
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai/openai-completions";
import type { Model } from "@mariozechner/pi-ai";
import type { App } from "obsidian";
import { resolveApiKey, type ObsidipiSettings } from "./settings";
import { editNoteTool, readNoteTool } from "./vault-tools";

const PROVIDER_BASE_URLS: Record<ObsidipiSettings["provider"], string> = {
	deepseek: "https://api.deepseek.com",
	anthropic: "https://api.anthropic.com",
	google: "https://generativelanguage.googleapis.com",
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
};

const MUTATING_TOOLS = new Set<string>(["edit_note"]);

const SYSTEM_PROMPT =
	"You are Obsidipi, an assistant inside an Obsidian vault on iOS. " +
	"You can read notes with read_note and propose edits with edit_note. " +
	"Vault paths are relative and must include the .md extension. " +
	"Every edit_note call is gated on explicit user approval — that's expected; do not " +
	"retry the same edit immediately if it gets rejected, ask the user what to do instead. " +
	"Be concise.";

export interface ApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: unknown;
	resolve: (approved: boolean) => void;
}

export type ApprovalRequester = (request: ApprovalRequest, signal?: AbortSignal) => void;

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

export function createAgent(
	app: App,
	settings: ObsidipiSettings,
	onApprovalNeeded: ApprovalRequester,
): Agent {
	return new Agent({
		initialState: {
			model: buildModel(settings),
			systemPrompt: SYSTEM_PROMPT,
			tools: [readNoteTool(app), editNoteTool(app)],
		},
		streamFn: streamSimpleOpenAICompletions,
		getApiKey: () => {
			const key = resolveApiKey(app, settings);
			return key ?? undefined;
		},
		beforeToolCall: async ({ toolCall, args }, signal) => {
			if (!MUTATING_TOOLS.has(toolCall.name)) return undefined;
			const approved = await waitForApproval(
				{ toolCallId: toolCall.id, toolName: toolCall.name, args },
				onApprovalNeeded,
				signal,
			);
			if (approved) return undefined;
			if (signal?.aborted) {
				return { block: true, reason: "Run aborted before approval." };
			}
			return { block: true, reason: "User rejected the edit." };
		},
	});
}

function waitForApproval(
	base: Omit<ApprovalRequest, "resolve">,
	onApprovalNeeded: ApprovalRequester,
	signal?: AbortSignal,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => settle(false);
		if (signal?.aborted) {
			settle(false);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		onApprovalNeeded({ ...base, resolve: settle }, signal);
	});
}
