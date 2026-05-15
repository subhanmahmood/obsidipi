import type { App, TFile, TFolder } from "obsidian";
import type { Message } from "@mariozechner/pi-ai";

export const THREADS_FOLDER = ".harness/threads";
const STATE_BLOCK_RE = /%%obsidipi-state\s*```json\s*([\s\S]*?)\s*```\s*%%/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const SLUG_MAX = 48;

export interface PersistedThread {
	id: string;
	title: string;
	provider: string;
	model: string;
	createdAt: string;
	updatedAt: string;
	messages: Message[];
	path?: string;
}

export interface ThreadSummary {
	id: string;
	title: string;
	path: string;
	updatedAt: string;
}

interface SerializedFrontmatter {
	obsidipi: "thread";
	id: string;
	title: string;
	provider: string;
	model: string;
	created: string;
	updated: string;
}

export function generateThreadId(): string {
	const now = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `${now}${rand}`;
}

export function slugifyTitle(text: string): string {
	const cleaned = text
		.replace(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g, "$1")
		.toLowerCase()
		.replace(/[^a-z0-9\s-]+/g, " ")
		.trim()
		.replace(/\s+/g, "-");
	return cleaned.slice(0, SLUG_MAX) || "thread";
}

export function defaultTitleFromMessage(text: string): string {
	const cleaned = text
		.replace(/@?\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned;
}

export function defaultThreadPath(
	createdAtIso: string,
	title: string,
	id: string,
): string {
	const date = createdAtIso.slice(0, 10);
	const slug = slugifyTitle(title);
	const shortId = id.slice(-6);
	return `${THREADS_FOLDER}/${date}-${slug}-${shortId}.md`;
}

export function renderThreadFile(thread: PersistedThread): string {
	const fm: SerializedFrontmatter = {
		obsidipi: "thread",
		id: thread.id,
		title: thread.title,
		provider: thread.provider,
		model: thread.model,
		created: thread.createdAt,
		updated: thread.updatedAt,
	};
	const frontmatter = renderFrontmatter(fm);
	const body = renderThreadBody(thread.messages);
	const stateBlock = renderStateBlock(thread.messages);
	return `${frontmatter}\n${body}\n${stateBlock}\n`;
}

function renderFrontmatter(fm: SerializedFrontmatter): string {
	const lines = [
		"---",
		`obsidipi: ${fm.obsidipi}`,
		`id: ${quoteIfNeeded(fm.id)}`,
		`title: ${quoteIfNeeded(fm.title)}`,
		`provider: ${quoteIfNeeded(fm.provider)}`,
		`model: ${quoteIfNeeded(fm.model)}`,
		`created: ${fm.created}`,
		`updated: ${fm.updated}`,
		"---",
	];
	return lines.join("\n");
}

function quoteIfNeeded(value: string): string {
	if (/^[A-Za-z0-9._/:+-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

function renderThreadBody(messages: Message[]): string {
	const out: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = extractText(msg.content);
			out.push("## user", "", text, "");
			continue;
		}
		if (msg.role === "assistant") {
			const textParts: string[] = [];
			const toolCalls: Array<{ name: string; id: string; input: unknown }> = [];
			for (const block of msg.content) {
				if (block.type === "text") textParts.push(block.text);
				else if (block.type === "toolCall") {
					toolCalls.push({
						name: block.name,
						id: block.id,
						input: block.arguments,
					});
				}
			}
			const text = textParts.join("").trim();
			if (text.length > 0) {
				out.push("## assistant", "", text, "");
			}
			for (const tc of toolCalls) {
				out.push(`### tool call · ${tc.name}`, "");
				out.push("```json");
				out.push(JSON.stringify(tc.input, null, 2));
				out.push("```", "");
			}
			continue;
		}
		if (msg.role === "toolResult") {
			const header = msg.isError
				? `## tool error · ${msg.toolName}`
				: `## tool · ${msg.toolName}`;
			out.push(header, "");
			const text = extractText(msg.content);
			if (text.length > 0) {
				out.push(text, "");
			}
			continue;
		}
	}
	return out.join("\n").trim();
}

function extractText(
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

function renderStateBlock(messages: Message[]): string {
	const payload = { version: 1 as const, messages };
	return [
		"%%obsidipi-state",
		"```json",
		JSON.stringify(payload),
		"```",
		"%%",
	].join("\n");
}

export function parseStateBlock(text: string): Message[] {
	const match = STATE_BLOCK_RE.exec(text);
	if (!match || !match[1]) {
		throw new Error("Thread file is missing the obsidipi-state JSON block.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]);
	} catch (e) {
		throw new Error(
			`Thread state block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!Array.isArray((parsed as { messages?: unknown }).messages)
	) {
		throw new Error("Thread state block is missing a `messages` array.");
	}
	return (parsed as { messages: Message[] }).messages;
}

export function parseFrontmatter(text: string): Record<string, string> {
	const match = FRONTMATTER_RE.exec(text);
	if (!match || !match[1]) return {};
	const out: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			try {
				value = JSON.parse(value.replace(/'/g, '"'));
			} catch {
				value = value.slice(1, -1);
			}
		}
		out[key] = value;
	}
	return out;
}

export async function ensureThreadsFolder(app: App): Promise<void> {
	const node = app.vault.getAbstractFileByPath(THREADS_FOLDER);
	if (node && "children" in node) return;
	if (node) {
		throw new Error(
			`Cannot create threads folder — '${THREADS_FOLDER}' exists as a file.`,
		);
	}
	// Obsidian's metadata cache sometimes hides dot-prefixed folders, so the
	// `null` from getAbstractFileByPath doesn't mean the folder is absent.
	// Check the adapter for ground truth before (re-)creating.
	const adapter = app.vault.adapter as
		| { exists?: (path: string) => Promise<boolean> }
		| undefined;
	if (adapter?.exists && (await adapter.exists(THREADS_FOLDER))) return;
	try {
		await app.vault.createFolder(THREADS_FOLDER);
	} catch (err) {
		// Lost a race or the folder appeared between our two checks — fine if it
		// now exists.
		if (adapter?.exists && (await adapter.exists(THREADS_FOLDER))) return;
		throw err;
	}
}

interface ThreadAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<{ mtime: number } | null>;
	trashSystem?(path: string): Promise<boolean>;
	trashLocal?(path: string): Promise<void>;
	remove?(path: string): Promise<void>;
}

function getAdapter(app: App): ThreadAdapter | null {
	const raw = app.vault.adapter as unknown as Partial<ThreadAdapter> | undefined;
	if (
		!raw ||
		typeof raw.exists !== "function" ||
		typeof raw.read !== "function" ||
		typeof raw.write !== "function" ||
		typeof raw.list !== "function"
	) {
		return null;
	}
	return raw as ThreadAdapter;
}

export async function deleteThread(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (file && "stat" in file && "extension" in file) {
		// Visible to the metadata cache — use the vault API so events fire and
		// open editor leaves can react.
		await app.vault.trash(file as TFile, true);
		return;
	}
	if (file) {
		throw new Error(`Cannot delete — '${path}' is a folder.`);
	}
	const adapter = getAdapter(app);
	if (!adapter) {
		throw new Error(`No thread at ${path}`);
	}
	if (!(await adapter.exists(path))) {
		throw new Error(`No thread at ${path}`);
	}
	if (adapter.trashSystem) {
		try {
			const ok = await adapter.trashSystem(path);
			if (ok) return;
		} catch {
			// fall through
		}
	}
	if (adapter.trashLocal) {
		try {
			await adapter.trashLocal(path);
			return;
		} catch {
			// fall through
		}
	}
	if (adapter.remove) {
		await adapter.remove(path);
		return;
	}
	throw new Error(`Adapter cannot delete files`);
}

export async function saveThread(
	app: App,
	thread: PersistedThread,
): Promise<PersistedThread> {
	const next: PersistedThread = {
		...thread,
		updatedAt: new Date().toISOString(),
	};
	const contents = renderThreadFile(next);
	const path = next.path ?? defaultThreadPath(next.createdAt, next.title, next.id);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing && "stat" in existing && "extension" in existing) {
		await app.vault.process(existing as TFile, () => contents);
		return { ...next, path };
	}
	if (existing) {
		throw new Error(`Cannot save thread — '${path}' exists but is a folder.`);
	}
	// Metadata cache may have missed a dot-folder file. Check the adapter.
	const adapter = getAdapter(app);
	if (adapter && (await adapter.exists(path))) {
		await adapter.write(path, contents);
		return { ...next, path };
	}
	await ensureThreadsFolder(app);
	try {
		await app.vault.create(path, contents);
	} catch (err) {
		// Vault.create can fail if the parent folder is invisible to the
		// metadata cache. Fall back to the adapter.
		if (adapter) {
			await adapter.write(path, contents);
		} else {
			throw err;
		}
	}
	return { ...next, path };
}

export async function loadThread(
	app: App,
	path: string,
): Promise<PersistedThread> {
	let text: string;
	const file = app.vault.getAbstractFileByPath(path);
	if (file && "stat" in file && "extension" in file) {
		text = await app.vault.cachedRead(file as TFile);
	} else if (file) {
		throw new Error(`Path is a folder, not a file: ${path}`);
	} else {
		const adapter = getAdapter(app);
		if (!adapter || !(await adapter.exists(path))) {
			throw new Error(`No thread at ${path}`);
		}
		text = await adapter.read(path);
	}
	const fm = parseFrontmatter(text);
	const messages = parseStateBlock(text);
	return {
		id: fm.id ?? "",
		title: fm.title ?? "Untitled",
		provider: fm.provider ?? "",
		model: fm.model ?? "",
		createdAt: fm.created ?? new Date().toISOString(),
		updatedAt: fm.updated ?? new Date().toISOString(),
		messages,
		path,
	};
}

function summaryFromText(
	text: string,
	path: string,
	mtimeMs: number,
): ThreadSummary | null {
	const fm = parseFrontmatter(text);
	if (fm.obsidipi !== "thread") return null;
	const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
	return {
		id: fm.id ?? basename,
		title: fm.title ?? basename,
		path,
		updatedAt: fm.updated ?? new Date(mtimeMs).toISOString(),
	};
}

export async function listThreads(app: App): Promise<ThreadSummary[]> {
	const out: ThreadSummary[] = [];
	const folder = app.vault.getAbstractFileByPath(THREADS_FOLDER);
	if (folder && "children" in folder) {
		for (const child of (folder as TFolder).children) {
			if (!("stat" in child && "extension" in child)) continue;
			const file = child as TFile;
			if (file.extension !== "md") continue;
			try {
				const text = await app.vault.cachedRead(file);
				const summary = summaryFromText(text, file.path, file.stat.mtime);
				if (summary) out.push(summary);
			} catch {
				// skip unreadable files
			}
		}
	} else if (!folder) {
		// Metadata cache doesn't see the dot-folder. Fall through to the adapter.
		const adapter = getAdapter(app);
		if (adapter && (await adapter.exists(THREADS_FOLDER))) {
			let listed: { files: string[]; folders: string[] };
			try {
				listed = await adapter.list(THREADS_FOLDER);
			} catch {
				return [];
			}
			for (const filePath of listed.files) {
				if (!filePath.endsWith(".md")) continue;
				try {
					const text = await adapter.read(filePath);
					const stat = await adapter.stat(filePath);
					const mtime = stat?.mtime ?? Date.now();
					const summary = summaryFromText(text, filePath, mtime);
					if (summary) out.push(summary);
				} catch {
					// skip unreadable
				}
			}
		}
	}
	out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return out;
}

export function makeNewThread(
	provider: string,
	model: string,
	firstUserMessage: string,
): PersistedThread {
	const now = new Date().toISOString();
	const title = defaultTitleFromMessage(firstUserMessage);
	return {
		id: generateThreadId(),
		title: title.length > 0 ? title : "Untitled",
		provider,
		model,
		createdAt: now,
		updatedAt: now,
		messages: [],
	};
}
