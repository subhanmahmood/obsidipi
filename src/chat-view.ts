import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
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
	private currentAssistantContent: HTMLDivElement | null = null;
	private currentAssistantText = "";
	private renderRafHandle: number | null = null;
	private renderGeneration = 0;
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
		this.cancelScheduledRender();
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
					const { bubble, content } = this.appendAssistantBubble();
					this.currentAssistantBubble = bubble;
					this.currentAssistantContent = content;
					this.currentAssistantText = "";
				}
				break;
			case "message_update":
				if (event.message.role === "assistant" && this.currentAssistantContent) {
					this.currentAssistantText = extractText(event.message);
					this.scheduleMarkdownRender();
				}
				break;
			case "message_end":
				if (event.message.role === "assistant" && this.currentAssistantContent && this.currentAssistantBubble) {
					this.currentAssistantText = extractText(event.message) || "(no response)";
					this.cancelScheduledRender();
					void this.renderMarkdownInto(this.currentAssistantContent, this.currentAssistantText);
					this.currentAssistantBubble.dataset.markdown = this.currentAssistantText;
					this.currentAssistantBubble = null;
					this.currentAssistantContent = null;
					this.currentAssistantText = "";
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

	private appendAssistantBubble(): { bubble: HTMLDivElement; content: HTMLDivElement } {
		const bubble = this.messagesEl.createDiv({
			cls: "obsidipi-bubble obsidipi-assistant markdown-rendered",
		});
		const content = bubble.createDiv({ cls: "obsidipi-assistant-content" });
		const copyBtn = bubble.createEl("button", {
			cls: "obsidipi-copy clickable-icon",
			attr: { "aria-label": "Copy markdown" },
		});
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.copyBubble(bubble, copyBtn);
		});
		this.scrollToBottom();
		return { bubble, content };
	}

	private async copyBubble(bubble: HTMLDivElement, btn: HTMLButtonElement) {
		const markdown = bubble.dataset.markdown ?? "";
		if (!markdown) {
			new Notice("Nothing to copy yet");
			return;
		}
		try {
			await navigator.clipboard.writeText(markdown);
			setIcon(btn, "check");
			window.setTimeout(() => setIcon(btn, "copy"), 1200);
		} catch {
			new Notice("Copy failed");
		}
	}

	private scheduleMarkdownRender() {
		if (this.renderRafHandle !== null) return;
		this.renderRafHandle = window.requestAnimationFrame(() => {
			this.renderRafHandle = null;
			const content = this.currentAssistantContent;
			if (!content) return;
			void this.renderMarkdownInto(content, this.currentAssistantText);
			this.scrollToBottom();
		});
	}

	private cancelScheduledRender() {
		if (this.renderRafHandle !== null) {
			window.cancelAnimationFrame(this.renderRafHandle);
			this.renderRafHandle = null;
		}
	}

	private async renderMarkdownInto(el: HTMLElement, markdown: string) {
		const gen = ++this.renderGeneration;
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		const tmp = document.createElement("div");
		await MarkdownRenderer.render(this.app, markdown, tmp, sourcePath, this);
		if (gen !== this.renderGeneration) return;
		el.empty();
		while (tmp.firstChild) el.appendChild(tmp.firstChild);
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
