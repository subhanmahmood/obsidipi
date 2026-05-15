import {
	ItemView,
	MarkdownRenderer,
	Notice,
	WorkspaceLeaf,
	prepareFuzzySearch,
	setIcon,
} from "obsidian";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, TextContent } from "@mariozechner/pi-ai";
import {
	deleteThread,
	listThreads,
	loadThread,
	makeNewThread,
	saveThread,
	type PersistedThread,
	type ThreadSummary,
} from "./thread-store";
import type ObsidipiPlugin from "./main";
import { createAgent, type ApprovalRequest } from "./agent-factory";
import type {
	AskUserRequest,
	PlanRequest,
	TodoItem,
	TodoStatus,
} from "./meta-tools";
import {
	collectCandidates,
	detectMentionTrigger,
	rankCandidates,
	type MentionTrigger,
	type NoteCandidate,
	type ScoredCandidate,
} from "./note-picker";

export const OBSIDIPI_VIEW_TYPE = "obsidipi-chat";

export class ObsidipiChatView extends ItemView {
	plugin: ObsidipiPlugin;
	private agent: Agent | null = null;
	private unsubscribe: (() => void) | null = null;
	private todosEl!: HTMLDivElement;
	private messagesEl!: HTMLDivElement;
	private inputEl!: HTMLDivElement;
	private sendBtn!: HTMLButtonElement;
	private currentAssistantBubble: HTMLDivElement | null = null;
	private currentAssistantContent: HTMLDivElement | null = null;
	private currentAssistantText = "";
	private renderRafHandle: number | null = null;
	private renderGeneration = 0;
	private toolBubbles = new Map<string, HTMLDivElement>();
	private todos: TodoItem[] = [];
	private mentionPopover: HTMLDivElement | null = null;
	private mentionTrigger: MentionTrigger | null = null;
	private mentionCandidates: NoteCandidate[] | null = null;
	private mentionRows: ScoredCandidate[] = [];
	private mentionSelected = 0;
	private mentionOutsideListener: ((e: MouseEvent | TouchEvent) => void) | null = null;
	private currentThread: PersistedThread | null = null;
	private saveChain: Promise<void> = Promise.resolve();
	private headerEl!: HTMLDivElement;
	private headerTitleEl!: HTMLSpanElement;
	private threadPanel: HTMLDivElement | null = null;
	private threadBackdrop: HTMLDivElement | null = null;

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

		this.renderHeader(root);

		this.todosEl = root.createDiv({ cls: "obsidipi-todos obsidipi-todos-empty" });
		this.renderTodos();

		this.messagesEl = root.createDiv({ cls: "obsidipi-messages" });
		this.messagesEl.addEventListener(
			"click",
			(e) => this.handleInternalLinkClick(e),
			true,
		);

		const inputRow = root.createDiv({ cls: "obsidipi-input-row" });
		this.inputEl = inputRow.createDiv({
			cls: "obsidipi-input is-empty",
			attr: {
				contenteditable: "true",
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": "Chat input",
				"data-placeholder": "Ask your vault…",
				spellcheck: "true",
			},
		});
		this.sendBtn = inputRow.createEl("button", {
			cls: "obsidipi-send",
			attr: { "aria-label": "Send message" },
		});
		setIcon(this.sendBtn, "arrow-up");

		this.sendBtn.addEventListener("click", () => void this.send());
		this.inputEl.addEventListener("input", () => {
			this.normalizeInputDom();
			this.updatePlaceholderState();
			this.refreshMentionPicker();
		});
		this.inputEl.addEventListener("keydown", (e) => this.onInputKeyDown(e));
		this.inputEl.addEventListener("keyup", (e) => {
			// Cursor movements via arrow keys don't fire "input"; refresh anyway.
			// But if the picker is open it already consumed the arrow keys —
			// re-ranking here would reset the highlighted row back to 0.
			if (this.mentionPopover) return;
			if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
				this.refreshMentionPicker();
			}
		});
		this.inputEl.addEventListener("click", () => this.refreshMentionPicker());
		this.inputEl.addEventListener("paste", (e) => this.onPaste(e));
		this.inputEl.addEventListener("blur", () => {
			// Defer so chip taps land before we tear the popover down.
			window.setTimeout(() => {
				if (document.activeElement !== this.inputEl) this.closeMentionPicker();
			}, 120);
		});
		this.updatePlaceholderState();
	}

	async onClose() {
		this.cancelScheduledRender();
		this.closeMentionPicker();
		this.unsubscribe?.();
		this.agent?.abort();
	}

	private onInputKeyDown(e: KeyboardEvent) {
		if (this.mentionPopover && this.mentionRows.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.moveMentionSelection(1);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				this.moveMentionSelection(-1);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				this.commitMention(this.mentionRows[this.mentionSelected] ?? null);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				this.closeMentionPicker();
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void this.send();
			return;
		}
		if (e.key === "Backspace") {
			if (this.handleBackspaceChip()) {
				e.preventDefault();
				this.updatePlaceholderState();
				this.refreshMentionPicker();
			}
		}
	}

	private handleBackspaceChip(): boolean {
		const sel = window.getSelection();
		if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
		const range = sel.getRangeAt(0);
		if (!this.inputEl.contains(range.startContainer)) return false;
		// Case 1: caret at offset 0 of a text node; check previous sibling.
		if (
			range.startContainer.nodeType === Node.TEXT_NODE &&
			range.startOffset === 0
		) {
			const prev = (range.startContainer as Text).previousSibling;
			if (isChipElement(prev)) {
				prev.remove();
				return true;
			}
		}
		// Case 2: caret directly inside the wrapper between two child elements.
		if (range.startContainer === this.inputEl && range.startOffset > 0) {
			const prev = this.inputEl.childNodes[range.startOffset - 1] ?? null;
			if (isChipElement(prev)) {
				prev.remove();
				return true;
			}
		}
		return false;
	}

	private onPaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData("text/plain") ?? "";
		if (text.length === 0) return;
		e.preventDefault();
		this.insertTextAtCaret(text);
		this.normalizeInputDom();
		this.updatePlaceholderState();
		this.refreshMentionPicker();
	}

	private insertTextAtCaret(text: string) {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || !this.inputEl.contains(sel.anchorNode)) {
			this.inputEl.appendChild(document.createTextNode(text));
			return;
		}
		const range = sel.getRangeAt(0);
		range.deleteContents();
		const node = document.createTextNode(text);
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	private normalizeInputDom() {
		// Clean up a lone <br> that browsers insert when the user deletes the last char.
		if (
			this.inputEl.children.length === 1 &&
			this.inputEl.firstChild instanceof HTMLBRElement &&
			(this.inputEl.textContent ?? "") === ""
		) {
			this.inputEl.firstChild.remove();
		}
	}

	private updatePlaceholderState() {
		const empty = serializeInputDom(this.inputEl).length === 0;
		this.inputEl.classList.toggle("is-empty", empty);
	}

	private getCaretContext(): {
		textNode: Text;
		offset: number;
		fullText: string;
	} | null {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		if (!range.collapsed) return null;
		if (!this.inputEl.contains(range.startContainer)) return null;
		const node = range.startContainer;
		if (node.nodeType !== Node.TEXT_NODE) return null;
		// Walk up to ensure we're not inside a chip.
		let parent: Node | null = node.parentNode;
		while (parent && parent !== this.inputEl) {
			if (parent instanceof HTMLElement && parent.classList.contains("obsidipi-chip")) {
				return null;
			}
			parent = parent.parentNode;
		}
		return {
			textNode: node as Text,
			offset: range.startOffset,
			fullText: node.textContent ?? "",
		};
	}

	private refreshMentionPicker() {
		const ctx = this.getCaretContext();
		if (!ctx) {
			this.closeMentionPicker();
			return;
		}
		const trigger = detectMentionTrigger(ctx.fullText, ctx.offset);
		if (!trigger) {
			this.closeMentionPicker();
			return;
		}
		this.mentionTrigger = trigger;
		if (this.mentionCandidates === null) {
			this.mentionCandidates = collectCandidates(this.app);
		}
		this.mentionRows = rankCandidates(
			trigger.query,
			this.mentionCandidates,
			(q) => prepareFuzzySearch(q),
		);
		this.mentionSelected = 0;
		this.renderMentionPicker();
	}

	private renderMentionPicker() {
		if (!this.mentionPopover) {
			const row = this.inputEl.parentElement as HTMLElement | null;
			if (!row) return;
			this.mentionPopover = row.createDiv({ cls: "obsidipi-mention" });
			this.mentionOutsideListener = (e) => {
				const target = e.target as Node | null;
				if (!target) return;
				if (this.mentionPopover?.contains(target)) return;
				if (this.inputEl.contains(target)) return;
				this.closeMentionPicker();
			};
			document.addEventListener("mousedown", this.mentionOutsideListener, true);
			document.addEventListener("touchstart", this.mentionOutsideListener, true);
		}
		const popover = this.mentionPopover;
		popover.empty();
		if (this.mentionRows.length === 0) {
			const empty = popover.createDiv({ cls: "obsidipi-mention-empty" });
			empty.setText(
				this.mentionTrigger && this.mentionTrigger.query.length > 0
					? `No notes match "${this.mentionTrigger.query}"`
					: "No notes in vault",
			);
			return;
		}
		for (let i = 0; i < this.mentionRows.length; i++) {
			const row = this.mentionRows[i];
			if (!row) continue;
			const rowEl = popover.createDiv({
				cls: `obsidipi-mention-row${i === this.mentionSelected ? " is-selected" : ""}`,
			});
			rowEl.createSpan({
				cls: "obsidipi-mention-name",
				text: row.candidate.basename,
			});
			const folder = pathFolder(row.candidate.path);
			if (folder.length > 0 || row.matchedKey === "alias") {
				const meta = rowEl.createSpan({ cls: "obsidipi-mention-meta" });
				if (row.matchedKey === "alias") {
					meta.setText(`alias · ${row.matchedText}${folder ? ` · ${folder}` : ""}`);
				} else {
					meta.setText(folder);
				}
			}
			// Use mousedown so the textarea doesn't blur before we commit.
			rowEl.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.commitMention(row);
			});
			rowEl.addEventListener("touchend", (e) => {
				e.preventDefault();
				this.commitMention(row);
			});
		}
	}

	private moveMentionSelection(delta: number) {
		if (this.mentionRows.length === 0) return;
		const n = this.mentionRows.length;
		this.mentionSelected = (this.mentionSelected + delta + n) % n;
		this.renderMentionPicker();
	}

	private commitMention(row: ScoredCandidate | null) {
		const trigger = this.mentionTrigger;
		if (!row || !trigger) {
			this.closeMentionPicker();
			return;
		}
		const ctx = this.getCaretContext();
		if (!ctx) {
			this.closeMentionPicker();
			return;
		}
		const { textNode, offset, fullText } = ctx;
		const before = fullText.slice(0, trigger.start);
		const after = fullText.slice(offset);
		const chip = createChipElement(row.candidate.basename, row.candidate.path);
		const afterText = ` ${after}`;
		const afterNode = document.createTextNode(afterText);
		const parent = textNode.parentNode;
		if (!parent) {
			this.closeMentionPicker();
			return;
		}
		const beforeNode = document.createTextNode(before);
		parent.insertBefore(beforeNode, textNode);
		parent.insertBefore(chip, textNode);
		parent.insertBefore(afterNode, textNode);
		parent.removeChild(textNode);
		const range = document.createRange();
		range.setStart(afterNode, 1);
		range.collapse(true);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		this.inputEl.focus();
		this.updatePlaceholderState();
		this.closeMentionPicker();
	}

	private closeMentionPicker() {
		this.mentionTrigger = null;
		this.mentionRows = [];
		this.mentionSelected = 0;
		this.mentionCandidates = null;
		if (this.mentionPopover) {
			this.mentionPopover.remove();
			this.mentionPopover = null;
		}
		if (this.mentionOutsideListener) {
			document.removeEventListener("mousedown", this.mentionOutsideListener, true);
			document.removeEventListener("touchstart", this.mentionOutsideListener, true);
			this.mentionOutsideListener = null;
		}
	}

	private ensureAgent(): Agent | null {
		if (this.agent) return this.agent;
		const settings = this.plugin.settings;
		if (!settings.apiKeyOrSecretName) {
			new Notice("Obsidipi: configure an API key in settings", 6000);
			return null;
		}
		this.agent = createAgent(this.app, settings, {
			requestApproval: (req) => this.renderApprovalCard(req),
			showPlan: (req) => this.renderPlanCard(req),
			askUser: (req) => this.renderAskCard(req),
			setTodos: (items) => this.setTodos(items),
			checkTodo: (id) => this.checkTodo(id),
		});
		if (this.currentThread && this.currentThread.messages.length > 0) {
			this.agent.state.messages = this.currentThread.messages;
		}
		this.unsubscribe = this.agent.subscribe((event) => this.onAgentEvent(event));
		return this.agent;
	}

	private async send() {
		const text = serializeInputDom(this.inputEl).trim();
		if (!text) return;
		this.ensureCurrentThread(text);
		const agent = this.ensureAgent();
		if (!agent) return;
		this.inputEl.replaceChildren();
		this.updatePlaceholderState();
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
					if (el.classList.contains("obsidipi-meta-resolved")) {
						// Plan/ask card already rendered its own resolved state.
					} else if (event.isError) {
						el.addClass("obsidipi-tool-error");
						const msg = extractToolErrorMessage(event.result);
						el.setText(`✗ ${event.toolName} failed: ${msg}`);
					} else {
						el.addClass("obsidipi-tool-ok");
						const summary = summarizeToolResult(event.toolName, event.result);
						el.setText(`✓ ${event.toolName}${summary ? " — " + summary : ""}`);
					}
				}
				this.toolBubbles.delete(event.toolCallId);
				this.scheduleThreadSave();
				break;
			}
			case "agent_end":
				this.scrollToBottom();
				this.scheduleThreadSave();
				break;
		}
	}

	private scheduleThreadSave() {
		if (!this.currentThread || !this.agent) return;
		const messages = [...this.agent.state.messages] as Message[];
		this.currentThread = { ...this.currentThread, messages };
		const snapshot = this.currentThread;
		this.saveChain = this.saveChain
			.catch(() => undefined)
			.then(async () => {
				try {
					const saved = await saveThread(this.app, snapshot);
					// Only adopt the saved path if no newer thread has replaced ours.
					if (this.currentThread && this.currentThread.id === saved.id) {
						this.currentThread = { ...this.currentThread, path: saved.path };
					}
				} catch (err) {
					console.error("[obsidipi] thread save failed", err);
					new Notice(
						`Obsidipi: failed to save thread — ${err instanceof Error ? err.message : String(err)}`,
						6000,
					);
				}
			});
	}

	private ensureCurrentThread(firstUserMessage: string) {
		if (this.currentThread) return;
		this.currentThread = makeNewThread(
			this.plugin.settings.provider,
			this.plugin.settings.model,
			firstUserMessage,
		);
		this.updateHeaderTitle();
	}

	private renderHeader(root: HTMLElement) {
		this.headerEl = root.createDiv({ cls: "obsidipi-header" });
		const menuBtn = this.headerEl.createEl("button", {
			cls: "obsidipi-header-btn",
			attr: { "aria-label": "Show threads" },
		});
		setIcon(menuBtn, "menu");
		menuBtn.addEventListener("click", () => void this.openThreadPanel());

		this.headerTitleEl = this.headerEl.createSpan({
			cls: "obsidipi-header-title",
		});

		const newBtn = this.headerEl.createEl("button", {
			cls: "obsidipi-header-btn",
			attr: { "aria-label": "New thread" },
		});
		setIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => this.startNewThread());

		this.updateHeaderTitle();
	}

	private updateHeaderTitle() {
		if (!this.headerTitleEl) return;
		const title = this.currentThread?.title?.trim();
		this.headerTitleEl.toggleClass("obsidipi-header-title-empty", !title);
		this.headerTitleEl.setText(title && title.length > 0 ? title : "New chat");
	}

	private async openThreadPanel() {
		if (this.threadPanel) {
			this.closeThreadPanel();
			return;
		}
		const root = this.containerEl.children[1] as HTMLElement;
		this.threadBackdrop = root.createDiv({ cls: "obsidipi-thread-backdrop" });
		this.threadBackdrop.addEventListener("click", () => this.closeThreadPanel());

		this.threadPanel = root.createDiv({ cls: "obsidipi-thread-panel" });

		const panelHeader = this.threadPanel.createDiv({
			cls: "obsidipi-thread-panel-header",
		});
		panelHeader.createSpan({
			cls: "obsidipi-thread-panel-title",
			text: "Threads",
		});
		const closeBtn = panelHeader.createEl("button", {
			cls: "obsidipi-header-btn",
			attr: { "aria-label": "Close threads" },
		});
		setIcon(closeBtn, "x");
		closeBtn.addEventListener("click", () => this.closeThreadPanel());

		const newRow = this.threadPanel.createDiv({
			cls: "obsidipi-thread-panel-new",
		});
		const plusIcon = newRow.createSpan({ cls: "obsidipi-thread-panel-plus" });
		setIcon(plusIcon, "plus");
		newRow.createSpan({ text: "New thread" });
		newRow.addEventListener("click", () => {
			this.closeThreadPanel();
			this.startNewThread();
		});

		const list = this.threadPanel.createDiv({
			cls: "obsidipi-thread-panel-list",
		});
		list.createDiv({
			cls: "obsidipi-thread-panel-loading",
			text: "Loading…",
		});

		// Slide in next frame so the CSS transition runs.
		requestAnimationFrame(() => {
			this.threadPanel?.addClass("is-open");
			this.threadBackdrop?.addClass("is-open");
		});

		try {
			const threads = await listThreads(this.app);
			this.renderThreadList(list, threads);
		} catch (err) {
			list.empty();
			list.createDiv({
				cls: "obsidipi-thread-panel-empty",
				text:
					err instanceof Error
						? `Failed to list threads: ${err.message}`
						: "Failed to list threads.",
			});
		}
	}

	private renderThreadList(container: HTMLElement, threads: ThreadSummary[]) {
		container.empty();
		if (threads.length === 0) {
			container.createDiv({
				cls: "obsidipi-thread-panel-empty",
				text: "No saved threads yet.",
			});
			return;
		}
		const groups = groupThreadsByRecency(threads);
		for (const group of groups) {
			if (group.threads.length === 0) continue;
			container.createDiv({
				cls: "obsidipi-thread-panel-group",
				text: group.label,
			});
			for (const t of group.threads) {
				this.renderThreadRow(container, t);
			}
		}
	}

	private renderThreadRow(container: HTMLElement, t: ThreadSummary) {
		const row = container.createDiv({ cls: "obsidipi-thread-row" });
		if (this.currentThread?.path === t.path) row.addClass("is-active");

		const content = row.createDiv({ cls: "obsidipi-thread-row-content" });
		content.createSpan({ cls: "obsidipi-thread-row-title", text: t.title });
		content.createSpan({
			cls: "obsidipi-thread-row-time",
			text: formatRelativeTime(t.updatedAt),
		});
		content.addEventListener("click", () => {
			this.closeThreadPanel();
			void this.openThreadAtPath(t.path);
		});

		const trashBtn = row.createEl("button", {
			cls: "obsidipi-thread-row-trash",
			attr: { "aria-label": "Delete thread" },
		});
		setIcon(trashBtn, "trash-2");
		trashBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.enterDeleteConfirm(row, t);
		});
	}

	private enterDeleteConfirm(row: HTMLDivElement, t: ThreadSummary) {
		row.addClass("is-confirming");
		const original = Array.from(row.childNodes);
		row.empty();

		const label = row.createSpan({
			cls: "obsidipi-thread-row-confirm-label",
			text: "Delete?",
		});
		void label;
		const actions = row.createDiv({ cls: "obsidipi-thread-row-confirm-actions" });
		const cancelBtn = actions.createEl("button", {
			cls: "obsidipi-thread-row-cancel",
			text: "Cancel",
		});
		const confirmBtn = actions.createEl("button", {
			cls: "obsidipi-thread-row-confirm mod-warning",
			text: "Delete",
		});

		const revert = () => {
			row.removeClass("is-confirming");
			row.empty();
			for (const node of original) row.appendChild(node);
		};

		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			revert();
		});
		confirmBtn.addEventListener("click", async (e) => {
			e.stopPropagation();
			confirmBtn.disabled = true;
			cancelBtn.disabled = true;
			confirmBtn.setText("Deleting…");
			try {
				await deleteThread(this.app, t.path);
				row.remove();
				if (this.currentThread?.path === t.path) {
					this.startNewThread();
				}
				new Notice(`Deleted: ${t.title}`, 2400);
			} catch (err) {
				console.error("[obsidipi] thread delete failed", err);
				new Notice(
					`Obsidipi: failed to delete — ${err instanceof Error ? err.message : String(err)}`,
					6000,
				);
				revert();
			}
		});
	}

	private closeThreadPanel() {
		if (this.threadPanel) {
			this.threadPanel.removeClass("is-open");
			const panel = this.threadPanel;
			window.setTimeout(() => panel.remove(), 220);
			this.threadPanel = null;
		}
		if (this.threadBackdrop) {
			this.threadBackdrop.removeClass("is-open");
			const backdrop = this.threadBackdrop;
			window.setTimeout(() => backdrop.remove(), 220);
			this.threadBackdrop = null;
		}
	}

	startNewThread() {
		// Pending writes for the old thread complete via the saveChain; reset here.
		this.agent?.abort();
		this.agent = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.currentThread = null;
		this.messagesEl.empty();
		this.todos = [];
		this.renderTodos();
		this.closeMentionPicker();
		this.inputEl.replaceChildren();
		this.updatePlaceholderState();
		this.updateHeaderTitle();
	}

	async openThreadAtPath(path: string) {
		try {
			const thread = await loadThread(this.app, path);
			this.agent?.abort();
			this.agent = null;
			this.unsubscribe?.();
			this.unsubscribe = null;
			this.currentThread = thread;
			this.messagesEl.empty();
			this.todos = [];
			this.renderTodos();
			this.closeMentionPicker();
			this.replayMessages(thread.messages);
			this.updateHeaderTitle();
			// Build the agent eagerly so the loaded messages seed its state.
			this.ensureAgent();
		} catch (err) {
			console.error("[obsidipi] thread load failed", err);
			new Notice(
				`Obsidipi: failed to load thread — ${err instanceof Error ? err.message : String(err)}`,
				6000,
			);
		}
	}

	private replayMessages(messages: Message[]) {
		for (const msg of messages) {
			if (msg.role === "user") {
				this.appendUserBubble(messageText(msg.content));
				continue;
			}
			if (msg.role === "assistant") {
				const textParts: string[] = [];
				for (const block of msg.content) {
					if (block.type === "text") textParts.push(block.text);
				}
				const text = textParts.join("");
				if (text.trim().length > 0) {
					const { bubble, content } = this.appendAssistantBubble();
					bubble.dataset.markdown = text;
					void this.renderMarkdownInto(content, text);
				}
				for (const block of msg.content) {
					if (block.type === "toolCall") {
						const el = this.messagesEl.createDiv({
							cls: "obsidipi-tool obsidipi-tool-ok",
						});
						el.setText(`▸ ${block.name}(${summarizeArgs(block.arguments)})`);
						this.toolBubbles.set(block.id, el);
					}
				}
				continue;
			}
			if (msg.role === "toolResult") {
				const el = this.toolBubbles.get(msg.toolCallId);
				if (el) {
					if (msg.isError) {
						el.removeClass("obsidipi-tool-ok");
						el.addClass("obsidipi-tool-error");
						const errText = extractToolErrorMessage({ content: msg.content });
						el.setText(`✗ ${msg.toolName} failed: ${errText}`);
					} else {
						const summary = summarizeToolResult(msg.toolName, {
							details: msg.details,
						});
						el.setText(`✓ ${msg.toolName}${summary ? " — " + summary : ""}`);
					}
					this.toolBubbles.delete(msg.toolCallId);
				}
				continue;
			}
		}
		this.scrollToBottom();
	}

	private appendUserBubble(text: string) {
		const el = this.messagesEl.createDiv({ cls: "obsidipi-bubble obsidipi-user" });
		void this.renderUserBubble(el, text);
		this.scrollToBottom();
	}

	private async renderUserBubble(el: HTMLDivElement, text: string) {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		const tmp = document.createElement("div");
		await MarkdownRenderer.render(this.app, text, tmp, sourcePath, this);
		// Replace internal-link anchors with the same .obsidipi-chip presentation
		// used by the input, so a sent message visually matches what the user
		// just typed. Keep the `internal-link` class + data-href so the existing
		// capture-phase click handler still routes the navigation.
		for (const link of Array.from(tmp.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
			const href = link.dataset.href ?? link.getAttribute("href") ?? "";
			const basename = extractBasename(href || link.textContent || "");
			const chip = document.createElement("a");
			chip.className = "obsidipi-chip internal-link";
			chip.dataset.href = href;
			chip.setAttribute("href", href);
			chip.textContent = basename;
			link.replaceWith(chip);
		}
		el.empty();
		while (tmp.firstChild) el.appendChild(tmp.firstChild);
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
		const args = (request.args ?? {}) as Record<string, unknown>;
		const path = typeof args.path === "string" ? args.path : "(unknown path)";
		const titleEl = container.createSpan({ cls: "obsidipi-approval-title" });
		const pathEl = container.createSpan({ cls: "obsidipi-approval-path" });
		pathEl.setText(path);
		if (request.toolName === "edit_note") {
			const oldText = typeof args.old === "string" ? args.old : "";
			const newText = typeof args.new === "string" ? args.new : "";
			titleEl.setText(describeEditIntent(oldText, newText));
			return;
		}
		if (request.toolName === "create_note") {
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content.length === 0 ? 0 : content.split("\n").length;
			titleEl.setText(
				lines === 0 ? "Create empty note" : `Create note (${lines} line${lines === 1 ? "" : "s"})`,
			);
			return;
		}
		if (request.toolName === "append_note") {
			const text = typeof args.text === "string" ? args.text : "";
			const lines = text.length === 0 ? 0 : text.split("\n").length;
			titleEl.setText(`Append ${lines} line${lines === 1 ? "" : "s"}`);
			return;
		}
		if (request.toolName === "trash_note") {
			titleEl.setText("Move to trash");
			return;
		}
		if (request.toolName === "move_note") {
			titleEl.setText("Move or rename");
			return;
		}
		if (request.toolName === "set_frontmatter") {
			const key = typeof args.key === "string" ? args.key : "";
			const isRemove = args.value === null;
			titleEl.setText(
				isRemove ? `Remove frontmatter \`${key}\`` : `Set frontmatter \`${key}\``,
			);
			return;
		}
		if (request.toolName === "add_tag") {
			const tag = typeof args.tag === "string"
				? args.tag.replace(/^#+/, "").trim()
				: "";
			titleEl.setText(`Add tag #${tag}`);
			return;
		}
		titleEl.setText(request.toolName);
	}

	private renderApprovalBody(container: HTMLElement, request: ApprovalRequest) {
		const args = (request.args ?? {}) as Record<string, unknown>;
		if (request.toolName === "edit_note") {
			const oldText = typeof args.old === "string" ? args.old : "";
			const newText = typeof args.new === "string" ? args.new : "";
			renderUnifiedDiff(container, oldText, newText);
			return;
		}
		if (request.toolName === "create_note") {
			const content = typeof args.content === "string" ? args.content : "";
			renderAdditionDiff(container, content);
			return;
		}
		if (request.toolName === "append_note") {
			const text = typeof args.text === "string" ? args.text : "";
			renderAdditionDiff(container, text);
			return;
		}
		if (request.toolName === "trash_note") {
			const warn = container.createDiv({ cls: "obsidipi-approval-warning" });
			warn.setText(
				"Note will be moved to the system trash. Recoverable on most platforms.",
			);
			return;
		}
		if (request.toolName === "move_note") {
			const newPath = typeof args.newPath === "string" ? args.newPath : "";
			const oldPath = typeof args.path === "string" ? args.path : "";
			const wrap = container.createDiv({ cls: "obsidipi-move" });
			const oldRow = wrap.createDiv({ cls: "obsidipi-move-row obsidipi-move-old" });
			oldRow.createSpan({ cls: "obsidipi-move-arrow", text: "from" });
			oldRow.createSpan({ cls: "obsidipi-move-path", text: oldPath });
			const newRow = wrap.createDiv({ cls: "obsidipi-move-row obsidipi-move-new" });
			newRow.createSpan({ cls: "obsidipi-move-arrow", text: "to" });
			newRow.createSpan({ cls: "obsidipi-move-path", text: newPath });
			return;
		}
		if (request.toolName === "set_frontmatter") {
			const key = typeof args.key === "string" ? args.key : "";
			const value = args.value;
			const wrap = container.createDiv({ cls: "obsidipi-fm" });
			const row = wrap.createDiv({ cls: "obsidipi-fm-row" });
			row.createSpan({ cls: "obsidipi-fm-key", text: `${key}:` });
			const val = row.createSpan({ cls: "obsidipi-fm-value" });
			if (value === null) {
				val.addClass("obsidipi-fm-removed");
				val.setText("(removed)");
			} else {
				val.setText(formatFrontmatterValue(value));
			}
			return;
		}
		if (request.toolName === "add_tag") {
			const tag = typeof args.tag === "string"
				? args.tag.replace(/^#+/, "").trim()
				: "";
			const wrap = container.createDiv({ cls: "obsidipi-fm" });
			const row = wrap.createDiv({ cls: "obsidipi-fm-row" });
			row.createSpan({ cls: "obsidipi-fm-key", text: "tags +=" });
			row.createSpan({ cls: "obsidipi-fm-value obsidipi-fm-tag", text: `#${tag}` });
			return;
		}
		const fallback = container.createEl("pre", { cls: "obsidipi-approval-args" });
		try {
			fallback.setText(JSON.stringify(request.args, null, 2));
		} catch {
			fallback.setText(String(request.args));
		}
	}

	private renderPlanCard(request: PlanRequest) {
		const bubble = this.toolBubbles.get(request.toolCallId);
		if (!bubble) return;
		bubble.removeClass("obsidipi-tool-running");
		bubble.addClass("obsidipi-plan");
		bubble.empty();

		const header = bubble.createDiv({ cls: "obsidipi-approval-header" });
		header.createSpan({
			cls: "obsidipi-approval-title",
			text: `Proposed plan (${request.steps.length} step${request.steps.length === 1 ? "" : "s"})`,
		});

		const body = bubble.createDiv({ cls: "obsidipi-approval-body" });
		const list = body.createEl("ol", { cls: "obsidipi-plan-steps" });
		for (const step of request.steps) {
			list.createEl("li", { text: step });
		}

		const noteWrap = body.createDiv({ cls: "obsidipi-plan-note" });
		const noteInput = noteWrap.createEl("input", {
			cls: "obsidipi-plan-note-input",
			attr: {
				type: "text",
				placeholder: "Optional note for the agent…",
				"aria-label": "Plan note",
			},
		});

		const actions = bubble.createDiv({ cls: "obsidipi-approval-actions" });
		const stopBtn = actions.createEl("button", {
			cls: "obsidipi-btn-reject",
			text: "Stop",
		});
		const goBtn = actions.createEl("button", {
			cls: "obsidipi-btn-approve mod-cta",
			text: "Go",
		});

		const settle = (approved: boolean) => {
			const note = noteInput.value.trim();
			stopBtn.disabled = true;
			goBtn.disabled = true;
			noteInput.disabled = true;
			bubble.removeClass("obsidipi-plan");
			bubble.addClass(approved ? "obsidipi-plan-approved" : "obsidipi-plan-rejected");
			bubble.addClass("obsidipi-meta-resolved");
			actions.empty();
			const pill = actions.createSpan({ cls: "obsidipi-approval-pill" });
			pill.setText(approved ? "Go" : "Stopped");
			if (note.length > 0) {
				const noteShown = noteWrap.createDiv({ cls: "obsidipi-plan-note-shown" });
				noteShown.setText(`Note: ${note}`);
			}
			noteWrap.removeChild(noteInput);
			request.resolve({ approved, note: note.length > 0 ? note : undefined });
		};

		goBtn.addEventListener("click", () => settle(true));
		stopBtn.addEventListener("click", () => settle(false));
		noteInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				settle(true);
			}
		});

		this.scrollToBottom();
	}

	private renderAskCard(request: AskUserRequest) {
		const bubble = this.toolBubbles.get(request.toolCallId);
		if (!bubble) return;
		bubble.removeClass("obsidipi-tool-running");
		bubble.addClass("obsidipi-ask");
		bubble.empty();

		const header = bubble.createDiv({ cls: "obsidipi-approval-header" });
		header.createSpan({
			cls: "obsidipi-approval-title",
			text: "Question",
		});

		const body = bubble.createDiv({ cls: "obsidipi-approval-body" });
		body.createEl("p", { cls: "obsidipi-ask-question", text: request.question });

		const chipsEl = body.createDiv({ cls: "obsidipi-ask-chips" });
		const replyWrap = body.createDiv({ cls: "obsidipi-ask-reply" });
		const replyInput = replyWrap.createEl("input", {
			cls: "obsidipi-ask-input",
			attr: {
				type: "text",
				placeholder: "Type a reply…",
				"aria-label": "Reply to question",
			},
		});
		const replySend = replyWrap.createEl("button", {
			cls: "obsidipi-ask-send",
			attr: { "aria-label": "Send reply" },
		});
		setIcon(replySend, "arrow-up");

		const settle = (answer: string, chip: boolean) => {
			const trimmed = answer.trim();
			if (trimmed.length === 0) return;
			replyInput.disabled = true;
			replySend.disabled = true;
			for (const btn of Array.from(chipsEl.querySelectorAll("button"))) {
				(btn as HTMLButtonElement).disabled = true;
			}
			bubble.removeClass("obsidipi-ask");
			bubble.addClass("obsidipi-ask-answered");
			bubble.addClass("obsidipi-meta-resolved");
			replyWrap.empty();
			const shown = body.createDiv({ cls: "obsidipi-ask-answer" });
			shown.createSpan({ cls: "obsidipi-ask-answer-label", text: "You: " });
			shown.createSpan({ text: trimmed });
			request.resolve({ answer: trimmed, chip });
		};

		for (const option of request.options) {
			const chip = chipsEl.createEl("button", {
				cls: "obsidipi-ask-chip",
				text: option,
			});
			chip.addEventListener("click", () => settle(option, true));
		}

		replySend.addEventListener("click", () => settle(replyInput.value, false));
		replyInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				settle(replyInput.value, false);
			}
		});

		window.setTimeout(() => replyInput.focus(), 0);
		this.scrollToBottom();
	}

	private setTodos(items: TodoItem[]) {
		this.todos = items.map((i) => ({ ...i }));
		this.renderTodos();
	}

	private checkTodo(id: string): { ok: boolean; item?: TodoItem } {
		const idx = this.todos.findIndex((i) => i.id === id);
		const current = idx === -1 ? undefined : this.todos[idx];
		if (idx === -1 || !current) return { ok: false };
		const updated: TodoItem = { ...current, status: "done" };
		this.todos[idx] = updated;
		this.renderTodos();
		return { ok: true, item: updated };
	}

	private renderTodos() {
		if (!this.todosEl) return;
		this.todosEl.empty();
		if (this.todos.length === 0) {
			this.todosEl.addClass("obsidipi-todos-empty");
			return;
		}
		this.todosEl.removeClass("obsidipi-todos-empty");
		const done = this.todos.filter((i) => i.status === "done").length;
		const header = this.todosEl.createDiv({ cls: "obsidipi-todos-header" });
		header.createSpan({
			cls: "obsidipi-todos-title",
			text: `Plan · ${done}/${this.todos.length}`,
		});
		const list = this.todosEl.createEl("ul", { cls: "obsidipi-todos-list" });
		for (const item of this.todos) {
			const row = list.createEl("li", {
				cls: `obsidipi-todo obsidipi-todo-${item.status}`,
			});
			row.createSpan({
				cls: "obsidipi-todo-glyph",
				text: todoGlyph(item.status),
			});
			row.createSpan({ cls: "obsidipi-todo-text", text: item.text });
		}
	}

	private scrollToBottom() {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private handleInternalLinkClick(e: MouseEvent) {
		const target = e.target;
		if (!(target instanceof Element)) return;
		const link = target.closest("a.internal-link") as HTMLAnchorElement | null;
		if (!link) return;
		const href = link.getAttribute("href") ?? link.dataset.href ?? "";
		if (href.length === 0) return;
		e.preventDefault();
		e.stopPropagation();
		this.openLinkInMainLeaf(href);
	}

	private openLinkInMainLeaf(linkText: string) {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
		const targetLeaf = markdownLeaves[0];
		if (targetLeaf) {
			this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
			void this.app.workspace.openLinkText(linkText, sourcePath, false);
			return;
		}
		void this.app.workspace.openLinkText(linkText, sourcePath, "tab");
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

function summarizeToolResult(toolName: string, result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return "";
	if (toolName === "edit_note" || toolName === "append_note") {
		if ("path" in details && "bytesBefore" in details && "bytesAfter" in details) {
			const d = details as { path: string; bytesBefore: number; bytesAfter: number };
			return `${d.path} (${d.bytesBefore} → ${d.bytesAfter} chars)`;
		}
	}
	if (toolName === "create_note") {
		if ("path" in details && "bytes" in details) {
			const d = details as { path: string; bytes: number };
			return `${d.path} (+${d.bytes} chars)`;
		}
	}
	if (toolName === "trash_note") {
		if ("path" in details) {
			const d = details as { path: string };
			return `${d.path} (trashed)`;
		}
	}
	if (toolName === "move_note") {
		if ("path" in details && "newPath" in details) {
			const d = details as { path: string; newPath: string };
			return `${d.path} → ${d.newPath}`;
		}
	}
	if (toolName === "set_frontmatter") {
		if ("path" in details && "key" in details && "removed" in details) {
			const d = details as { path: string; key: string; removed: boolean };
			return `${d.path} · ${d.removed ? `−${d.key}` : d.key}`;
		}
	}
	if (toolName === "add_tag") {
		if ("path" in details && "tag" in details && "alreadyPresent" in details) {
			const d = details as { path: string; tag: string; alreadyPresent: boolean };
			return `${d.path} · #${d.tag}${d.alreadyPresent ? " (already present)" : ""}`;
		}
	}
	if (toolName === "search_vault") {
		if ("query" in details && "matches" in details) {
			const d = details as {
				query: string;
				matches: unknown[];
				totalScanned?: number;
			};
			const n = d.matches.length;
			const scanned = typeof d.totalScanned === "number" ? d.totalScanned : null;
			const scope = scanned !== null ? `, scanned ${scanned}` : "";
			return `"${d.query}" — ${n} match${n === 1 ? "" : "es"}${scope}`;
		}
	}
	if (toolName === "list_folder") {
		if ("path" in details && "count" in details) {
			const d = details as { path: string; count: number };
			const where = d.path === "" ? "/" : d.path;
			return `${where} — ${d.count} item${d.count === 1 ? "" : "s"}`;
		}
	}
	if (toolName === "read_note" || toolName === "get_active_note") {
		if ("path" in details && "bytes" in details) {
			const d = details as { path: string; bytes: number };
			return `${d.path} (${d.bytes} chars)`;
		}
	}
	if (toolName === "get_backlinks") {
		if ("path" in details && "count" in details) {
			const d = details as { path: string; count: number };
			return `${d.path} — ${d.count} backlink${d.count === 1 ? "" : "s"}`;
		}
	}
	if (toolName === "get_notes_by_tag") {
		if ("tag" in details && "count" in details) {
			const d = details as { tag: string; count: number };
			return `#${d.tag} — ${d.count} note${d.count === 1 ? "" : "s"}`;
		}
	}
	if (toolName === "get_daily_note") {
		if ("date" in details && "path" in details && "exists" in details) {
			const d = details as { date: string; path: string; exists: boolean };
			return `${d.date} → ${d.path}${d.exists ? "" : " (missing)"}`;
		}
	}
	if (toolName === "get_headings") {
		if ("path" in details && "count" in details) {
			const d = details as { path: string; count: number };
			return `${d.path} — ${d.count} heading${d.count === 1 ? "" : "s"}`;
		}
	}
	if (toolName === "plan") {
		if ("steps" in details && "approved" in details) {
			const d = details as { steps: unknown[]; approved: boolean };
			const n = d.steps.length;
			return `${n} step${n === 1 ? "" : "s"} — ${d.approved ? "approved" : "rejected"}`;
		}
	}
	if (toolName === "ask_user") {
		if ("answer" in details) {
			const d = details as { answer: string };
			const trimmed = d.answer.length > 60 ? `${d.answer.slice(0, 60)}…` : d.answer;
			return `answered "${trimmed}"`;
		}
	}
	if (toolName === "todo_write") {
		if ("count" in details) {
			const d = details as { count: number };
			return `${d.count} item${d.count === 1 ? "" : "s"}`;
		}
	}
	if (toolName === "todo_check") {
		if ("text" in details) {
			const d = details as { text: string };
			const trimmed = d.text.length > 60 ? `${d.text.slice(0, 60)}…` : d.text;
			return `'${trimmed}'`;
		}
	}
	return "";
}

function todoGlyph(status: TodoStatus): string {
	if (status === "done") return "✓";
	if (status === "in_progress") return "◐";
	return "○";
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

function formatFrontmatterValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return String(value);
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function renderAdditionDiff(container: HTMLElement, text: string) {
	container.addClass("obsidipi-diff");
	if (text.length === 0) {
		container.createDiv({ cls: "obsidipi-diff-empty", text: "(empty)" });
		return;
	}
	const allLines = text.split("\n");
	const visible = allLines.slice(0, DIFF_VISIBLE_LINES);
	const hidden = allLines.length - visible.length;
	const list = container.createDiv({ cls: "obsidipi-diff-lines" });
	for (const line of visible) appendDiffLine(list, "add", line);
	if (hidden > 0) {
		const more = container.createEl("button", {
			cls: "obsidipi-diff-expand",
			text: `Show ${hidden} more line${hidden === 1 ? "" : "s"}`,
		});
		more.addEventListener("click", () => {
			more.remove();
			for (const line of allLines.slice(DIFF_VISIBLE_LINES)) {
				appendDiffLine(list, "add", line);
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

function pathFolder(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

function extractBasename(pathOrName: string): string {
	const last = pathOrName.split("/").pop() ?? pathOrName;
	const dot = last.lastIndexOf(".");
	return dot === -1 ? last : last.slice(0, dot);
}

interface ThreadGroup {
	label: string;
	threads: ThreadSummary[];
}

function groupThreadsByRecency(threads: ThreadSummary[]): ThreadGroup[] {
	const now = new Date();
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
	const startOfWeek = new Date(startOfToday.getTime() - 6 * 86_400_000);

	const today: ThreadSummary[] = [];
	const yesterday: ThreadSummary[] = [];
	const thisWeek: ThreadSummary[] = [];
	const earlier: ThreadSummary[] = [];

	for (const t of threads) {
		const d = new Date(t.updatedAt);
		if (Number.isNaN(d.getTime())) {
			earlier.push(t);
			continue;
		}
		if (d >= startOfToday) today.push(t);
		else if (d >= startOfYesterday) yesterday.push(t);
		else if (d >= startOfWeek) thisWeek.push(t);
		else earlier.push(t);
	}

	return [
		{ label: "Today", threads: today },
		{ label: "Yesterday", threads: yesterday },
		{ label: "Earlier this week", threads: thisWeek },
		{ label: "Earlier", threads: earlier },
	];
}

function formatRelativeTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const now = Date.now();
	const diff = now - date.getTime();
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	const weeks = Math.floor(days / 7);
	if (weeks < 5) return `${weeks}w`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;
	const years = Math.floor(days / 365);
	return `${years}y`;
}

function messageText(
	content: string | Array<{ type: string; text?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("");
}

function createChipElement(label: string, path: string): HTMLSpanElement {
	const chip = document.createElement("span");
	chip.className = "obsidipi-chip";
	chip.contentEditable = "false";
	chip.dataset.path = path;
	chip.setAttribute("draggable", "false");
	chip.textContent = label;
	return chip;
}

function isChipElement(node: Node | null): node is HTMLElement {
	return (
		node instanceof HTMLElement && node.classList.contains("obsidipi-chip")
	);
}

function serializeInputDom(root: HTMLElement): string {
	let out = "";
	const walk = (node: Node, atBlockStart: boolean): boolean => {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.textContent ?? "";
			return false;
		}
		if (node instanceof HTMLBRElement) {
			out += "\n";
			return true;
		}
		if (node instanceof HTMLElement) {
			if (node.classList.contains("obsidipi-chip")) {
				const path = node.dataset.path ?? "";
				out += `[[${path}]]`;
				return false;
			}
			// Some browsers wrap newlines in <div>. Insert a separator unless
			// we're already at a fresh block boundary.
			const isBlock = node.tagName === "DIV" || node.tagName === "P";
			if (isBlock && !atBlockStart && out.length > 0) {
				out += "\n";
			}
			let nextAtBlockStart = isBlock;
			for (const child of Array.from(node.childNodes)) {
				nextAtBlockStart = walk(child, nextAtBlockStart);
			}
			return false;
		}
		return false;
	};
	let atBlockStart = true;
	for (const child of Array.from(root.childNodes)) {
		atBlockStart = walk(child, atBlockStart);
	}
	return out;
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
