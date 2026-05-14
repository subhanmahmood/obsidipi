import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type ObsidipiPlugin from "./main";
import { createAgent, type ApprovalRequest } from "./agent-factory";

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
		this.agent = createAgent(this.app, settings, (req) => this.renderApprovalCard(req));
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
			attr: { "aria-label": "Copy response" },
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

	private renderApprovalCard(request: ApprovalRequest) {
		const bubble = this.toolBubbles.get(request.toolCallId);
		if (!bubble) return;
		bubble.removeClass("obsidipi-tool-running");
		bubble.addClass("obsidipi-approval");
		bubble.empty();

		const header = bubble.createDiv({ cls: "obsidipi-approval-header" });
		this.renderApprovalHeader(header, request);

		const body = bubble.createDiv({ cls: "obsidipi-approval-body" });
		this.renderApprovalBody(body, request);

		const actions = bubble.createDiv({ cls: "obsidipi-approval-actions" });
		const rejectBtn = actions.createEl("button", {
			cls: "obsidipi-btn-reject",
			text: "Reject",
		});
		const approveBtn = actions.createEl("button", {
			cls: "obsidipi-btn-approve mod-cta",
			text: "Approve",
		});

		const settle = (approved: boolean) => {
			rejectBtn.disabled = true;
			approveBtn.disabled = true;
			bubble.removeClass("obsidipi-approval");
			bubble.addClass(approved ? "obsidipi-approval-resolved" : "obsidipi-approval-rejected");
			actions.empty();
			const pill = actions.createSpan({ cls: "obsidipi-approval-pill" });
			pill.setText(approved ? "Approved" : "Rejected");
			request.resolve(approved);
		};

		approveBtn.addEventListener("click", () => settle(true));
		rejectBtn.addEventListener("click", () => settle(false));

		this.scrollToBottom();
	}

	private renderApprovalHeader(container: HTMLElement, request: ApprovalRequest) {
		if (request.toolName === "edit_note") {
			const args = request.args as { path?: unknown; old?: unknown; new?: unknown };
			const path = typeof args.path === "string" ? args.path : "(unknown path)";
			const oldText = typeof args.old === "string" ? args.old : "";
			const newText = typeof args.new === "string" ? args.new : "";
			const titleEl = container.createSpan({ cls: "obsidipi-approval-title" });
			titleEl.setText(describeEditIntent(oldText, newText));
			const pathEl = container.createSpan({ cls: "obsidipi-approval-path" });
			pathEl.setText(path);
			return;
		}
		container.createSpan({ cls: "obsidipi-approval-title", text: request.toolName });
	}

	private renderApprovalBody(container: HTMLElement, request: ApprovalRequest) {
		if (request.toolName === "edit_note") {
			const args = request.args as { old?: unknown; new?: unknown };
			const oldText = typeof args.old === "string" ? args.old : "";
			const newText = typeof args.new === "string" ? args.new : "";
			renderUnifiedDiff(container, oldText, newText);
			return;
		}
		const fallback = container.createEl("pre", { cls: "obsidipi-approval-args" });
		try {
			fallback.setText(JSON.stringify(request.args, null, 2));
		} catch {
			fallback.setText(String(request.args));
		}
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
		.map(([k, v]) => {
			const raw = typeof v === "string" ? v : JSON.stringify(v) ?? "";
			const trimmed = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
			return `${k}=${typeof v === "string" ? JSON.stringify(trimmed) : trimmed}`;
		})
		.join(", ")
		.slice(0, 160);
}

function summarizeToolResult(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return "";
	if ("path" in details && "bytesBefore" in details && "bytesAfter" in details) {
		const d = details as { path: string; bytesBefore: number; bytesAfter: number };
		return `${d.path} (${d.bytesBefore} → ${d.bytesAfter} chars)`;
	}
	if ("path" in details && "bytes" in details) {
		const d = details as { path: string; bytes: number };
		return `${d.path} (${d.bytes} chars)`;
	}
	return "";
}

const DIFF_VISIBLE_LINES = 12;

function renderUnifiedDiff(container: HTMLElement, oldText: string, newText: string) {
	container.addClass("obsidipi-diff");
	const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
	const newLines = newText.length === 0 ? [] : newText.split("\n");
	const lines: { kind: "del" | "add"; text: string }[] = [
		...oldLines.map((t) => ({ kind: "del" as const, text: t })),
		...newLines.map((t) => ({ kind: "add" as const, text: t })),
	];
	if (lines.length === 0) {
		const empty = container.createDiv({ cls: "obsidipi-diff-empty" });
		empty.setText("(no change)");
		return;
	}

	const visible = lines.slice(0, DIFF_VISIBLE_LINES);
	const hidden = lines.length - visible.length;
	const list = container.createDiv({ cls: "obsidipi-diff-lines" });
	for (const line of visible) appendDiffLine(list, line.kind, line.text);

	if (hidden > 0) {
		const more = container.createEl("button", {
			cls: "obsidipi-diff-expand",
			text: `Show ${hidden} more line${hidden === 1 ? "" : "s"}`,
		});
		more.addEventListener("click", () => {
			more.remove();
			for (const line of lines.slice(DIFF_VISIBLE_LINES)) {
				appendDiffLine(list, line.kind, line.text);
			}
		});
	}
}

function appendDiffLine(list: HTMLElement, kind: "del" | "add", text: string) {
	const row = list.createDiv({
		cls: `obsidipi-diff-line obsidipi-diff-${kind}`,
	});
	row.createSpan({
		cls: "obsidipi-diff-gutter",
		text: kind === "del" ? "−" : "+",
	});
	const content = row.createSpan({ cls: "obsidipi-diff-text" });
	if (text.length === 0) {
		content.addClass("obsidipi-diff-blank");
		content.setText("⏎");
	} else if (text.trim().length === 0) {
		content.addClass("obsidipi-diff-ws");
		content.setText("·".repeat(Math.min(text.length, 40)));
	} else {
		content.setText(text);
	}
}

function describeEditIntent(oldText: string, newText: string): string {
	const oldLines = oldText.length === 0 ? 0 : oldText.split("\n").length;
	const newLines = newText.length === 0 ? 0 : newText.split("\n").length;
	if (oldText.length === 0 && newText.length > 0) {
		return `Insert ${newLines} line${newLines === 1 ? "" : "s"}`;
	}
	if (newText.length === 0 && oldText.length > 0) {
		return `Delete ${oldLines} line${oldLines === 1 ? "" : "s"}`;
	}
	if (oldLines === 1 && newLines === 1) return "Replace 1 line";
	return `Replace ${oldLines} → ${newLines} lines`;
}

function extractToolErrorMessage(result: unknown): string {
	if (!result || typeof result !== "object") return "unknown error";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "unknown error";
	const [first] = content as unknown[];
	if (first && typeof first === "object" && "text" in first) {
		return String((first as { text: unknown }).text).slice(0, 200);
	}
	return "unknown error";
}
