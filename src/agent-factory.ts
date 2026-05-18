import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
	streamSimpleOpenAICompletions,
} from "@mariozechner/pi-ai/openai-completions";
import type { Model } from "@mariozechner/pi-ai";
import type { App } from "obsidian";
import {
	resolveApiKey,
	resolveWebSearchApiKey,
	type ObsidipiSettings,
	type WebSearchProvider,
} from "./settings";
import { webSearchTool } from "./web-search";
import {
	addTagTool,
	appendNoteTool,
	createNoteTool,
	editNoteTool,
	getActiveNoteTool,
	getBacklinksTool,
	getDailyNoteTool,
	getHeadingsTool,
	getNotesByTagTool,
	listFolderTool,
	moveNoteTool,
	readNoteTool,
	searchVaultTool,
	setFrontmatterTool,
	trashNoteTool,
} from "./vault-tools";
import {
	askUserTool,
	type MetaUxBridge,
	planTool,
	todoCheckTool,
	todoWriteTool,
} from "./meta-tools";

const PROVIDER_BASE_URLS: Record<ObsidipiSettings["provider"], string> = {
	deepseek: "https://api.deepseek.com",
	anthropic: "https://api.anthropic.com",
	google: "https://generativelanguage.googleapis.com",
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
};

const MUTATING_TOOLS = new Set<string>([
	"edit_note",
	"create_note",
	"append_note",
	"trash_note",
	"move_note",
	"set_frontmatter",
	"add_tag",
]);

function buildSystemPrompt(webSearchEnabled: boolean): string {
	const webSearchClause = webSearchEnabled
		? "web_search (search the public web; use when the user asks about recent events, external facts, or anything not in the vault — cite URLs in your reply). "
		: "";
	return (
		"You are Obsidipi, an assistant inside an Obsidian vault on iOS. " +
		"Vault tools: " +
		"search_vault (case-insensitive substring search across all markdown notes; use first when the user mentions a topic but not a path), " +
		"get_active_note (the note the user currently has open; use when they say 'this note' / 'the current note'), " +
		"list_folder (browse vault structure), " +
		"read_note (read a specific note by path), " +
		"edit_note (propose a diff-based edit to a single note), " +
		"create_note (create a new note; auto-creates parent folders; fails if path exists), " +
		"append_note (append text to the end of an existing note — the most common write op for daily logs and inbox capture), " +
		"trash_note (move a note to the system trash, recoverable), " +
		"move_note (move/rename a note; incoming links update automatically), " +
		"set_frontmatter (set or remove a frontmatter key; pass null to remove), " +
		"add_tag (add a tag to a note's frontmatter `tags:` array), " +
		"get_backlinks (list notes linking to a target note via Obsidian's resolved-link index), " +
		"get_notes_by_tag (find notes by tag — matches the tag and any nested sub-tags), " +
		"get_daily_note (resolve the daily note for a date using the Daily Notes plugin config; default today), " +
		"get_headings (outline a note's headings with levels and line numbers — call before structural edits). " +
		(webSearchEnabled ? `External tools: ${webSearchClause}` : "") +
		"Meta tools (no vault I/O): " +
		"plan (propose an ordered list of steps and pause for 'Go'/'Stop' — use before any multi-step work), " +
		"todo_write (replace the visible todo list; each item has id, text, and optional status of pending/in_progress/done — call this up front and again when items move to in_progress), " +
		"todo_check (mark a todo done by id — call as each step completes), " +
		"ask_user (pause to ask a clarifying question with optional quick-reply chips — use sparingly, only when guessing would risk wrong work). " +
		"Vault paths are relative and must include the .md extension. " +
		"Wiki-links of the form `[[note.md]]` in user messages are explicit pointers to vault " +
		"notes — treat them as authoritative paths and call read_note on them when you need the " +
		"contents (don't search for them). " +
		"When relaying search_vault results to the user, keep them as a bullet list and preserve " +
		"`[[note.md]]` wiki-link syntax verbatim — do not reformat into a table, that drops the " +
		"link clickability. " +
		"Every mutating tool (edit_note, create_note, append_note, trash_note, move_note, " +
		"set_frontmatter, add_tag) is gated on explicit user approval — that's expected; do not " +
		"retry the same write immediately if it gets rejected, ask the user what to do instead. " +
		"For longer tasks: call plan first, then todo_write, then execute step-by-step, calling " +
		"todo_check after each step. If a plan is rejected, don't propose the same plan again — " +
		"ask the user what they'd prefer. " +
		"Be concise."
	);
}

export interface ApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: unknown;
	resolve: (approved: boolean) => void;
}

export type ApprovalRequester = (request: ApprovalRequest, signal?: AbortSignal) => void;

export interface ChatViewBridge extends MetaUxBridge {
	requestApproval: ApprovalRequester;
}

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
	bridge: ChatViewBridge,
): Agent {
	const webSearchEnabled = settings.webSearchProvider !== "off";
	const tools: AgentTool<any>[] = [
		searchVaultTool(app),
		getActiveNoteTool(app),
		listFolderTool(app),
		readNoteTool(app),
		editNoteTool(app),
		createNoteTool(app),
		appendNoteTool(app),
		trashNoteTool(app),
		moveNoteTool(app),
		setFrontmatterTool(app),
		addTagTool(app),
		getBacklinksTool(app),
		getNotesByTagTool(app),
		getDailyNoteTool(app),
		getHeadingsTool(app),
		planTool(bridge),
		askUserTool(bridge),
		todoWriteTool(bridge),
		todoCheckTool(bridge),
	];
	if (webSearchEnabled) {
		tools.push(
			webSearchTool(
				app,
				() => resolveWebSearchApiKey(app, settings),
				() => settings.webSearchProvider as WebSearchProvider,
			),
		);
	}
	return new Agent({
		initialState: {
			model: buildModel(settings),
			systemPrompt: buildSystemPrompt(webSearchEnabled),
			tools,
		},
		streamFn: streamSimpleOpenAICompletions,
		// Always provide getApiKey so pi-ai never reaches its env-var fallback path
		// in `env-api-keys.ts`. That file contains a `require("node:fs")` gated on
		// `process.versions?.bun && empty process.env` — dead on iOS (where
		// `process` is undefined) but still visible in the bundle. Supplying the
		// key here guarantees the fallback is never invoked.
		getApiKey: () => {
			const key = resolveApiKey(app, settings);
			return key ?? undefined;
		},
		beforeToolCall: async ({ toolCall, args }, signal) => {
			if (!MUTATING_TOOLS.has(toolCall.name)) return undefined;
			const approved = await waitForApproval(
				{ toolCallId: toolCall.id, toolName: toolCall.name, args },
				bridge.requestApproval,
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
