import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type ObsidipiPlugin from "./main";
import { createAgent } from "./agent-factory";

export const OBSIDIPI_VIEW_TYPE = "obsidipi-chat";

export class ObsidipiChatView extends ItemView {
	plugin: ObsidipiPlugin;
	private agent: Agent | null = null;
	private unsubscribe: (() => void) | null = null;
	private messagesEl!: HTMLDivElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private currentAssistantBubble: HTMLDivElement | null = null;
	private toolBubbles = new Map<string, HTMLDivElement>();

	constructor(leaf: WorkspaceLeaf, plugin: ObsidipiPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return OBSIDIPI_VIEW_TYPE;
	}

	getDisplayText() {
		return "Obsidipi";
	}

	getIcon() {
		return "message-square";
	}

	async onOpen() {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("obsidipi-root");

		this.messagesEl = root.createDiv({ cls: "obsidipi-messages" });

		const inputRow = root.createDiv({ cls: "obsidipi-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "obsidipi-input",
			attr: { placeholder: "Ask your vault…", rows: "2" },
		});
		this.sendBtn = inputRow.createEl("button", {
			cls: "obsidipi-send",
			text: "Send",
		});

		this.sendBtn.addEventListener("click", () => void this.send());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		});
	}

	async onClose() {
		this.unsubscribe?.();
		this.agent?.abort();
	}

	private ensureAgent(): Agent | null {
		if (this.agent) return this.agent;
		const settings = this.plugin.settings;
		if (!settings.apiKeyOrSecretName) {
			new Notice("Obsidipi: configure an API key in settings", 6000);
			return null;
		}
		this.agent = createAgent(this.app, settings);
		this.unsubscribe = this.agent.subscribe((event) => this.onAgentEvent(event));
		return this.agent;
	}

	private async send() {
		const text = this.inputEl.value.trim();
		if (!text) return;
		const agent = this.ensureAgent();
		if (!agent) return;
		this.inputEl.value = "";
		this.sendBtn.disabled = true;
		this.appendUserBubble(text);
		this.currentAssistantBubble = null;
		try {
			await agent.prompt(text);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.appendErrorBubble(msg);
		} finally {
			this.sendBtn.disabled = false;
		}
	}

	private onAgentEvent(event: AgentEvent) {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.currentAssistantBubble = this.appendAssistantBubble("");
				}
				break;
			case "message_update":
				if (event.message.role === "assistant" && this.currentAssistantBubble) {
					this.currentAssistantBubble.setText(extractText(event.message));
					this.scrollToBottom();
				}
				break;
			case "message_end":
				if (event.message.role === "assistant" && this.currentAssistantBubble) {
					const text = extractText(event.message);
					this.currentAssistantBubble.setText(text || "(no response)");
					this.currentAssistantBubble = null;
					if (event.message.stopReason === "error" && event.message.errorMessage) {
						this.appendErrorBubble(event.message.errorMessage);
					}
				}
				break;
			case "tool_execution_start": {
				const argSummary = summarizeArgs(event.args);
				const el = this.messagesEl.createDiv({ cls: "obsidipi-tool obsidipi-tool-running" });
				el.setText(`▸ ${event.toolName}(${argSummary}) — running…`);
				this.toolBubbles.set(event.toolCallId, el);
				this.currentAssistantBubble = null;
				this.scrollToBottom();
				break;
			}
			case "tool_execution_end": {
				const el = this.toolBubbles.get(event.toolCallId);
				if (el) {
					el.removeClass("obsidipi-tool-running");
					if (event.isError) {
						el.addClass("obsidipi-tool-error");
						const msg = extractToolErrorMessage(event.result);
						el.setText(`✗ ${event.toolName} failed: ${msg}`);
					} else {
						el.addClass("obsidipi-tool-ok");
						const summary = summarizeToolResult(event.result);
						el.setText(`✓ ${event.toolName}${summary ? " — " + summary : ""}`);
					}
				}
				this.toolBubbles.delete(event.toolCallId);
				break;
			}
			case "agent_end":
				this.scrollToBottom();
				break;
		}
	}

	private appendUserBubble(text: string) {
		const el = this.messagesEl.createDiv({ cls: "obsidipi-bubble obsidipi-user" });
		el.setText(text);
		this.scrollToBottom();
	}

	private appendAssistantBubble(text: string): HTMLDivElement {
		const el = this.messagesEl.createDiv({
			cls: "obsidipi-bubble obsidipi-assistant",
		});
		if (text) el.setText(text);
		this.scrollToBottom();
		return el;
	}

	private appendErrorBubble(text: string) {
		const el = this.messagesEl.createDiv({ cls: "obsidipi-bubble obsidipi-error" });
		el.setText(`Error: ${text}`);
		this.scrollToBottom();
	}

	private scrollToBottom() {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("");
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>);
	return entries
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(", ")
		.slice(0, 120);
}

function summarizeToolResult(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return "";
	if ("path" in details && "bytes" in details) {
		const d = details as { path: string; bytes: number };
		return `${d.path} (${d.bytes} chars)`;
	}
	return "";
}

function extractToolErrorMessage(result: unknown): string {
	if (!result || typeof result !== "object") return "unknown error";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "unknown error";
	const first = content[0];
	if (first && typeof first === "object" && "text" in first) {
		return String((first as { text: unknown }).text).slice(0, 200);
	}
	return "unknown error";
}
