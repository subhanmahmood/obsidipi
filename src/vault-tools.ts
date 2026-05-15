import { Type, type Static } from "typebox";
import type { App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const ReadNoteParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the note, with extension (e.g. 'inbox/today.md').",
	}),
});

export function readNoteTool(app: App): AgentTool<typeof ReadNoteParams, { path: string; bytes: number }> {
	return {
		name: "read_note",
		label: "Read note",
		description:
			"Read the full text of a note from the active Obsidian vault. " +
			"Path is vault-relative and must include the file extension (.md). " +
			"Returns the file contents as text.",
		parameters: ReadNoteParams,
		executionMode: "parallel",
		execute: async (
			_toolCallId: string,
			params: Static<typeof ReadNoteParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			const text = await app.vault.cachedRead(file);
			return {
				content: [{ type: "text", text }],
				details: { path: params.path, bytes: text.length },
			};
		},
	};
}

const EditNoteParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the note, with extension (e.g. 'inbox/today.md').",
	}),
	old: Type.String({
		description:
			"Exact text to replace. Must be present and occur exactly once in the file. " +
			"Match is case-sensitive and whitespace-sensitive.",
	}),
	new: Type.String({
		description:
			"Replacement text. Pass an empty string to delete the matched region.",
	}),
});

export interface EditNoteDetails {
	path: string;
	bytesBefore: number;
	bytesAfter: number;
	old: string;
	new: string;
}

export function editNoteTool(app: App): AgentTool<typeof EditNoteParams, EditNoteDetails> {
	return {
		name: "edit_note",
		label: "Edit note",
		description:
			"Replace exactly one occurrence of `old` with `new` in the named note. " +
			"Use enough surrounding context in `old` to make the match unique — if the text " +
			"is missing or appears more than once, the call fails. " +
			"Every edit_note call requires explicit user approval before it takes effect.",
		parameters: EditNoteParams,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<typeof EditNoteParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			if (params.old.length === 0) {
				throw new Error("`old` must be a non-empty string.");
			}
			let bytesBefore = 0;
			let bytesAfter = 0;
			await app.vault.process(file, (data) => {
				bytesBefore = data.length;
				const idx = data.indexOf(params.old);
				if (idx === -1) {
					throw new Error(
						"`old` text was not found in the note. The match is exact and case-sensitive.",
					);
				}
				const second = data.indexOf(params.old, idx + params.old.length);
				if (second !== -1) {
					throw new Error(
						"`old` text occurs more than once. Provide more surrounding context so the match is unique.",
					);
				}
				const next =
					data.slice(0, idx) + params.new + data.slice(idx + params.old.length);
				bytesAfter = next.length;
				return next;
			});
			return {
				content: [
					{
						type: "text",
						text: `Edited ${params.path} (${bytesBefore} → ${bytesAfter} chars).`,
					},
				],
				details: {
					path: params.path,
					bytesBefore,
					bytesAfter,
					old: params.old,
					new: params.new,
				},
			};
		},
	};
}

function isTFile(file: object): file is TFile {
	return "stat" in file && "extension" in file;
}

function isTFolder(file: object): file is TFolder {
	return (
		"children" in file &&
		Array.isArray((file as { children?: unknown }).children)
	);
}

const SearchVaultParams = Type.Object({
	query: Type.String({
		description:
			"Substring to search for. Matching is case-insensitive against markdown file contents.",
	}),
	scope: Type.Optional(
		Type.String({
			description:
				"Optional folder path to limit the search (e.g. 'projects' or 'projects/'). Files with paths that don't start with this prefix are skipped.",
		}),
	),
	maxResults: Type.Optional(
		Type.Integer({
			description: "Maximum number of matching files to return. Default 20.",
			minimum: 1,
			maximum: 100,
		}),
	),
});

export interface SearchMatch {
	path: string;
	line: number;
	snippet: string;
}

export interface SearchVaultDetails {
	query: string;
	scope: string | null;
	totalScanned: number;
	matches: SearchMatch[];
}

const SNIPPET_RADIUS = 60;

export function searchVaultTool(
	app: App,
): AgentTool<typeof SearchVaultParams, SearchVaultDetails> {
	return {
		name: "search_vault",
		label: "Search vault",
		description:
			"Search markdown notes in the vault for a case-insensitive substring. " +
			"Use this when the user mentions a topic but not a path. " +
			"Returns up to `maxResults` matching files, each with the line number and a short snippet around the first match. " +
			"Use the optional `scope` to limit to a folder prefix.",
		parameters: SearchVaultParams,
		executionMode: "parallel",
		execute: async (_id, params) => {
			const query = params.query;
			if (query.length === 0) {
				throw new Error("`query` must be a non-empty string.");
			}
			const needle = query.toLowerCase();
			const scope = normalizeScope(params.scope);
			const limit = params.maxResults ?? 20;
			const files = app.vault.getMarkdownFiles();
			const matches: SearchMatch[] = [];
			let scanned = 0;
			for (const file of files) {
				if (scope && !file.path.startsWith(scope)) continue;
				scanned++;
				const text = await app.vault.cachedRead(file);
				const idx = text.toLowerCase().indexOf(needle);
				if (idx === -1) continue;
				matches.push({
					path: file.path,
					line: lineNumberAt(text, idx),
					snippet: snippetAround(text, idx, query.length),
				});
				if (matches.length >= limit) break;
			}
			const rendered = renderSearchResults(query, scope, matches);
			return {
				content: [{ type: "text", text: rendered }],
				details: { query, scope, totalScanned: scanned, matches },
			};
		},
	};
}

function normalizeScope(scope: string | undefined): string | null {
	if (!scope) return null;
	const trimmed = scope.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed.length === 0 ? null : `${trimmed}/`;
}

function lineNumberAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

function snippetAround(text: string, index: number, matchLength: number): string {
	const start = Math.max(0, index - SNIPPET_RADIUS);
	const end = Math.min(text.length, index + matchLength + SNIPPET_RADIUS);
	const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${slice}${suffix}`;
}

function renderSearchResults(
	query: string,
	scope: string | null,
	matches: SearchMatch[],
): string {
	if (matches.length === 0) {
		const where = scope ? ` in \`${scope}\`` : "";
		return `No matches for "${query}"${where}.`;
	}
	const header =
		`${matches.length} match${matches.length === 1 ? "" : "es"} for "${query}"` +
		(scope ? ` in \`${scope}\`` : "") +
		":";
	const lines = matches.map(
		(m) => `- [[${m.path}]] line ${m.line}\n  > ${m.snippet}`,
	);
	return `${header}\n${lines.join("\n")}`;
}

const GetActiveNoteParams = Type.Object({});

export interface GetActiveNoteDetails {
	path: string;
	bytes: number;
}

export function getActiveNoteTool(
	app: App,
): AgentTool<typeof GetActiveNoteParams, GetActiveNoteDetails> {
	return {
		name: "get_active_note",
		label: "Get active note",
		description:
			"Return the path and full contents of the markdown note the user currently has open in Obsidian. " +
			"Use this whenever the user refers to 'this note' or 'the current note' without naming a path. " +
			"Fails if no markdown note is active.",
		parameters: GetActiveNoteParams,
		executionMode: "parallel",
		execute: async () => {
			const file = app.workspace.getActiveFile();
			if (!file) {
				throw new Error("No file is currently active in the workspace.");
			}
			if (file.extension !== "md") {
				throw new Error(`Active file is not a markdown note: ${file.path}`);
			}
			const text = await app.vault.cachedRead(file);
			return {
				content: [{ type: "text", text: `# ${file.path}\n\n${text}` }],
				details: { path: file.path, bytes: text.length },
			};
		},
	};
}

const ListFolderParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative folder path. Use an empty string or '/' for the vault root.",
	}),
	recursive: Type.Optional(
		Type.Boolean({
			description:
				"If true, list all descendants. Default false (immediate children only).",
		}),
	),
});

export interface ListFolderEntry {
	path: string;
	kind: "file" | "folder";
}

export interface ListFolderDetails {
	path: string;
	recursive: boolean;
	count: number;
	entries: ListFolderEntry[];
}

export function listFolderTool(
	app: App,
): AgentTool<typeof ListFolderParams, ListFolderDetails> {
	return {
		name: "list_folder",
		label: "List folder",
		description:
			"List the contents of a folder in the vault. Returns files and subfolders, with folders marked by a trailing slash. " +
			"Pass recursive=true to walk all descendants. Use '' or '/' for the vault root.",
		parameters: ListFolderParams,
		executionMode: "parallel",
		execute: async (_id, params) => {
			const folder = resolveFolder(app, params.path);
			const recursive = params.recursive ?? false;
			const entries = recursive
				? collectDescendants(folder)
				: folder.children.map(toEntry);
			entries.sort(compareEntries);
			const rendered = renderListing(folder.path, entries);
			return {
				content: [{ type: "text", text: rendered }],
				details: {
					path: folder.path,
					recursive,
					count: entries.length,
					entries,
				},
			};
		},
	};
}

function resolveFolder(app: App, rawPath: string): TFolder {
	if (rawPath === "" || rawPath === "/") {
		return app.vault.getRoot();
	}
	const normalized = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
	const node = app.vault.getAbstractFileByPath(normalized);
	if (!node) {
		throw new Error(`No folder at vault path: ${normalized}`);
	}
	if (!isTFolder(node)) {
		throw new Error(`Path is a file, not a folder: ${normalized}`);
	}
	return node;
}

function toEntry(child: TAbstractFile): ListFolderEntry {
	return {
		path: child.path,
		kind: isTFolder(child) ? "folder" : "file",
	};
}

function collectDescendants(folder: TFolder): ListFolderEntry[] {
	const out: ListFolderEntry[] = [];
	const stack: TAbstractFile[] = [...folder.children];
	while (stack.length > 0) {
		const node = stack.pop()!;
		out.push(toEntry(node));
		if (isTFolder(node)) {
			for (const child of node.children) stack.push(child);
		}
	}
	return out;
}

function compareEntries(a: ListFolderEntry, b: ListFolderEntry): number {
	if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
	return a.path.localeCompare(b.path);
}

function renderListing(folderPath: string, entries: ListFolderEntry[]): string {
	const label = folderPath === "" ? "/" : folderPath;
	if (entries.length === 0) return `${label} is empty.`;
	const lines = entries.map(
		(e) => `- ${e.path}${e.kind === "folder" ? "/" : ""}`,
	);
	return `${label} (${entries.length}):\n${lines.join("\n")}`;
}

const CreateNoteParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path for the new note, with extension (e.g. 'inbox/today.md'). " +
			"Parent folders that don't exist are created automatically.",
	}),
	content: Type.String({
		description:
			"Initial file contents. Pass an empty string to create an empty note.",
	}),
});

export interface CreateNoteDetails {
	path: string;
	bytes: number;
	content: string;
}

export function createNoteTool(
	app: App,
): AgentTool<typeof CreateNoteParams, CreateNoteDetails> {
	return {
		name: "create_note",
		label: "Create note",
		description:
			"Create a new note at the given vault path with the provided content. " +
			"Parent folders are auto-created if missing. " +
			"Fails if anything already exists at that path — use edit_note or append_note instead. " +
			"Every create_note call requires explicit user approval before it takes effect.",
		parameters: CreateNoteParams,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<typeof CreateNoteParams>,
		) => {
			const normalized = params.path.replace(/^\/+/, "");
			if (normalized.length === 0) {
				throw new Error("`path` must be a non-empty vault-relative path.");
			}
			if (app.vault.getAbstractFileByPath(normalized)) {
				throw new Error(`A file or folder already exists at: ${normalized}`);
			}
			const slash = normalized.lastIndexOf("/");
			if (slash > 0) {
				const parent = normalized.slice(0, slash);
				const existing = app.vault.getAbstractFileByPath(parent);
				if (existing && !isTFolder(existing)) {
					throw new Error(
						`Parent path exists as a file, not a folder: ${parent}`,
					);
				}
				if (!existing) {
					await app.vault.createFolder(parent);
				}
			}
			await app.vault.create(normalized, params.content);
			return {
				content: [
					{
						type: "text",
						text: `Created ${normalized} (${params.content.length} chars).`,
					},
				],
				details: {
					path: normalized,
					bytes: params.content.length,
					content: params.content,
				},
			};
		},
	};
}

const AppendNoteParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the note, with extension (e.g. 'inbox/today.md').",
	}),
	text: Type.String({
		description:
			"Text to append. A leading newline is inserted automatically when the existing " +
			"file is non-empty and doesn't already end in a newline.",
	}),
});

export interface AppendNoteDetails {
	path: string;
	bytesBefore: number;
	bytesAfter: number;
	text: string;
}

export function appendNoteTool(
	app: App,
): AgentTool<typeof AppendNoteParams, AppendNoteDetails> {
	return {
		name: "append_note",
		label: "Append to note",
		description:
			"Append text to the end of an existing note. Inserts a separating newline " +
			"when the file already has content and doesn't end with one, so block-level " +
			"markdown stays valid. " +
			"Every append_note call requires explicit user approval before it takes effect.",
		parameters: AppendNoteParams,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<typeof AppendNoteParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			if (params.text.length === 0) {
				throw new Error("`text` must be a non-empty string.");
			}
			let bytesBefore = 0;
			let bytesAfter = 0;
			await app.vault.process(file, (data) => {
				bytesBefore = data.length;
				const separator =
					data.length === 0 || data.endsWith("\n") ? "" : "\n";
				const next = data + separator + params.text;
				bytesAfter = next.length;
				return next;
			});
			return {
				content: [
					{
						type: "text",
						text: `Appended to ${params.path} (${bytesBefore} → ${bytesAfter} chars).`,
					},
				],
				details: {
					path: params.path,
					bytesBefore,
					bytesAfter,
					text: params.text,
				},
			};
		},
	};
}

const MoveNoteParams = Type.Object({
	path: Type.String({
		description:
			"Current vault-relative path of the note, with extension (e.g. 'inbox/old.md').",
	}),
	newPath: Type.String({
		description:
			"New vault-relative path, with extension. Parent folders are created if missing. " +
			"Use this to rename (same folder, new filename) or move (different folder).",
	}),
});

export interface MoveNoteDetails {
	path: string;
	newPath: string;
}

export function moveNoteTool(
	app: App,
): AgentTool<typeof MoveNoteParams, MoveNoteDetails> {
	return {
		name: "move_note",
		label: "Move or rename note",
		description:
			"Move or rename a note. Incoming `[[wiki-links]]` and markdown links are updated " +
			"automatically by Obsidian. Parent folders for the new path are auto-created. " +
			"Fails if anything already exists at the new path. " +
			"Every move_note call requires explicit user approval before it takes effect.",
		parameters: MoveNoteParams,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<typeof MoveNoteParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			const target = params.newPath.replace(/^\/+/, "");
			if (target.length === 0) {
				throw new Error("`newPath` must be a non-empty vault-relative path.");
			}
			if (target === params.path) {
				throw new Error("`newPath` is the same as the current path.");
			}
			if (app.vault.getAbstractFileByPath(target)) {
				throw new Error(`A file or folder already exists at: ${target}`);
			}
			const slash = target.lastIndexOf("/");
			if (slash > 0) {
				const parent = target.slice(0, slash);
				const existing = app.vault.getAbstractFileByPath(parent);
				if (existing && !isTFolder(existing)) {
					throw new Error(
						`Parent path exists as a file, not a folder: ${parent}`,
					);
				}
				if (!existing) {
					await app.vault.createFolder(parent);
				}
			}
			await app.fileManager.renameFile(file, target);
			return {
				content: [
					{
						type: "text",
						text: `Moved ${params.path} → ${target}.`,
					},
				],
				details: { path: params.path, newPath: target },
			};
		},
	};
}

const SetFrontmatterParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the note, with extension (e.g. 'inbox/today.md').",
	}),
	key: Type.String({
		description:
			"Frontmatter key to set. Must be a non-empty string.",
	}),
	value: Type.Unknown({
		description:
			"New value for the key. Strings, numbers, booleans, arrays, and objects are all " +
			"preserved as YAML. Pass `null` to remove the key entirely.",
	}),
});

export interface SetFrontmatterDetails {
	path: string;
	key: string;
	value: unknown;
	previousValue: unknown;
	removed: boolean;
}

export function setFrontmatterTool(
	app: App,
): AgentTool<typeof SetFrontmatterParams, SetFrontmatterDetails> {
	return {
		name: "set_frontmatter",
		label: "Set frontmatter",
		description:
			"Set a single frontmatter key on a note via Obsidian's safe frontmatter editor. " +
			"Preserves the rest of the YAML block. Pass `null` as the value to remove the key. " +
			"Every set_frontmatter call requires explicit user approval before it takes effect.",
		parameters: SetFrontmatterParams,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<typeof SetFrontmatterParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			if (params.key.length === 0) {
				throw new Error("`key` must be a non-empty string.");
			}
			const removed = params.value === null;
			let previousValue: unknown = undefined;
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				previousValue = fm[params.key];
				if (removed) {
					delete fm[params.key];
				} else {
					fm[params.key] = params.value;
				}
			});
			const summary = removed
				? `Removed \`${params.key}\` from ${params.path}.`
				: `Set \`${params.key}\` on ${params.path}.`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					path: params.path,
					key: params.key,
					value: params.value,
					previousValue,
					removed,
				},
			};
		},
	};
}

const AddTagParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the note, with extension (e.g. 'inbox/today.md').",
	}),
	tag: Type.String({
		description:
			"Tag to add. Leading `#` is stripped automatically; nested tags are allowed (e.g. 'project/alpha').",
	}),
});

export interface AddTagDetails {
	path: string;
	tag: string;
	alreadyPresent: boolean;
	tags: string[];
}

export function addTagTool(
	app: App,
): AgentTool<typeof AddTagParams, AddTagDetails> {
	return {
		name: "add_tag",
		label: "Add tag",
		description:
			"Add a tag to a note's frontmatter `tags:` array. The leading `#` is stripped " +
			"automatically. If the tag is already present, the call is a no-op but still " +
			"succeeds. A scalar `tags:` value is converted to a single-element array first. " +
			"Every add_tag call requires explicit user approval before it takes effect.",
		parameters: AddTagParams,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<typeof AddTagParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			const tag = params.tag.replace(/^#+/, "").trim();
			if (tag.length === 0) {
				throw new Error(
					"`tag` must be a non-empty string (after stripping leading `#`).",
				);
			}
			let alreadyPresent = false;
			let finalTags: string[] = [];
			await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				const current = fm.tags;
				let list: string[];
				if (Array.isArray(current)) {
					list = current.map((t) => String(t));
				} else if (typeof current === "string" && current.length > 0) {
					list = [current];
				} else {
					list = [];
				}
				if (list.includes(tag)) {
					alreadyPresent = true;
				} else {
					list.push(tag);
				}
				fm.tags = list;
				finalTags = list;
			});
			const text = alreadyPresent
				? `\`#${tag}\` was already on ${params.path} (no change).`
				: `Tagged ${params.path} with \`#${tag}\`.`;
			return {
				content: [{ type: "text", text }],
				details: { path: params.path, tag, alreadyPresent, tags: finalTags },
			};
		},
	};
}

const GetBacklinksParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the target note, with extension (e.g. 'inbox/today.md'). " +
			"Returns every note in the vault that links to this one.",
	}),
});

export interface BacklinkEntry {
	path: string;
	count: number;
}

export interface GetBacklinksDetails {
	path: string;
	count: number;
	sources: BacklinkEntry[];
}

export function getBacklinksTool(
	app: App,
): AgentTool<typeof GetBacklinksParams, GetBacklinksDetails> {
	return {
		name: "get_backlinks",
		label: "Get backlinks",
		description:
			"List every note that links to the target note. " +
			"Returns the source path and number of links. " +
			"Powered by Obsidian's resolved-link index — only resolved links count.",
		parameters: GetBacklinksParams,
		executionMode: "parallel",
		execute: async (
			_toolCallId: string,
			params: Static<typeof GetBacklinksParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			const resolved = app.metadataCache.resolvedLinks as Record<
				string,
				Record<string, number>
			>;
			const sources: BacklinkEntry[] = [];
			for (const sourcePath of Object.keys(resolved)) {
				if (sourcePath === file.path) continue;
				const count = resolved[sourcePath]?.[file.path];
				if (count && count > 0) sources.push({ path: sourcePath, count });
			}
			sources.sort(
				(a, b) => b.count - a.count || a.path.localeCompare(b.path),
			);
			const text = renderBacklinks(file.path, sources);
			return {
				content: [{ type: "text", text }],
				details: { path: file.path, count: sources.length, sources },
			};
		},
	};
}

function renderBacklinks(path: string, sources: BacklinkEntry[]): string {
	if (sources.length === 0) return `No backlinks to [[${path}]].`;
	const header = `${sources.length} note${sources.length === 1 ? "" : "s"} link${sources.length === 1 ? "s" : ""} to [[${path}]]:`;
	const lines = sources.map(
		(s) => `- [[${s.path}]]${s.count > 1 ? ` (×${s.count})` : ""}`,
	);
	return `${header}\n${lines.join("\n")}`;
}

const GetNotesByTagParams = Type.Object({
	tag: Type.String({
		description:
			"Tag to search for. Leading `#` is stripped automatically. " +
			"Matches the exact tag and any nested sub-tags (e.g. 'area' matches 'area/work').",
	}),
});

export interface NotesByTagEntry {
	path: string;
	tags: string[];
}

export interface GetNotesByTagDetails {
	tag: string;
	count: number;
	notes: NotesByTagEntry[];
}

export function getNotesByTagTool(
	app: App,
): AgentTool<typeof GetNotesByTagParams, GetNotesByTagDetails> {
	return {
		name: "get_notes_by_tag",
		label: "Find notes by tag",
		description:
			"Find every note tagged with the given tag, whether the tag lives in frontmatter " +
			"`tags:` or inline in the body. Leading `#` is stripped from the query. " +
			"Matches nested sub-tags as well — searching `area` returns notes tagged `area`, " +
			"`area/work`, and `area/home/sub`.",
		parameters: GetNotesByTagParams,
		executionMode: "parallel",
		execute: async (
			_toolCallId: string,
			params: Static<typeof GetNotesByTagParams>,
		) => {
			const needle = params.tag.replace(/^#+/, "").trim();
			if (needle.length === 0) {
				throw new Error(
					"`tag` must be a non-empty string (after stripping leading `#`).",
				);
			}
			const files = app.vault.getMarkdownFiles();
			const notes: NotesByTagEntry[] = [];
			for (const file of files) {
				const tags = collectTagsForFile(app, file);
				const matched = tags.filter((t) => tagMatches(t, needle));
				if (matched.length > 0) {
					notes.push({ path: file.path, tags: matched });
				}
			}
			notes.sort((a, b) => a.path.localeCompare(b.path));
			const text = renderNotesByTag(needle, notes);
			return {
				content: [{ type: "text", text }],
				details: { tag: needle, count: notes.length, notes },
			};
		},
	};
}

function collectTagsForFile(app: App, file: TFile): string[] {
	const cache = app.metadataCache.getFileCache(file);
	const out = new Set<string>();
	const fm = cache?.frontmatter;
	if (fm) {
		const raw = (fm as Record<string, unknown>).tags;
		if (Array.isArray(raw)) {
			for (const t of raw) {
				const norm = normalizeTag(t);
				if (norm) out.add(norm);
			}
		} else if (typeof raw === "string" && raw.length > 0) {
			const norm = normalizeTag(raw);
			if (norm) out.add(norm);
		}
	}
	const inline = cache?.tags;
	if (Array.isArray(inline)) {
		for (const t of inline) {
			const norm = normalizeTag(t.tag);
			if (norm) out.add(norm);
		}
	}
	return Array.from(out).sort();
}

function normalizeTag(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const t = raw.replace(/^#+/, "").trim();
	return t.length === 0 ? null : t;
}

function tagMatches(tag: string, query: string): boolean {
	return tag === query || tag.startsWith(`${query}/`);
}

function renderNotesByTag(tag: string, notes: NotesByTagEntry[]): string {
	if (notes.length === 0) return `No notes tagged \`#${tag}\`.`;
	const header = `${notes.length} note${notes.length === 1 ? "" : "s"} tagged \`#${tag}\`:`;
	const lines = notes.map((n) => {
		const extra = n.tags.filter((t) => t !== tag);
		const suffix = extra.length > 0 ? ` — also \`#${extra.join("`, `#")}\`` : "";
		return `- [[${n.path}]]${suffix}`;
	});
	return `${header}\n${lines.join("\n")}`;
}

const GetDailyNoteParams = Type.Object({
	date: Type.Optional(
		Type.String({
			description:
				"ISO date `YYYY-MM-DD`. Defaults to today (local time) if omitted.",
		}),
	),
});

export interface GetDailyNoteDetails {
	date: string;
	path: string;
	exists: boolean;
	bytes: number;
	folder: string;
	format: string;
}

export function getDailyNoteTool(
	app: App,
): AgentTool<typeof GetDailyNoteParams, GetDailyNoteDetails> {
	return {
		name: "get_daily_note",
		label: "Get daily note",
		description:
			"Resolve and read the daily note for a given date (default: today). " +
			"Uses the Daily Notes core plugin's configured folder + filename format when " +
			"available; falls back to `YYYY-MM-DD.md` at the vault root. " +
			"Returns the note contents if the file exists; otherwise returns the resolved path " +
			"so the caller can decide whether to create it.",
		parameters: GetDailyNoteParams,
		executionMode: "parallel",
		execute: async (
			_toolCallId: string,
			params: Static<typeof GetDailyNoteParams>,
		) => {
			const date = params.date ?? formatToday();
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				throw new Error(
					`Invalid date: ${date}. Expected YYYY-MM-DD.`,
				);
			}
			const parsed = parseIsoDate(date);
			if (!parsed) {
				throw new Error(`Invalid calendar date: ${date}.`);
			}
			const { folder, format } = resolveDailyNotesConfig(app);
			const filename = `${formatMomentLike(parsed, format)}.md`;
			const path = folder ? `${folder.replace(/\/+$/, "")}/${filename}` : filename;
			const file = app.vault.getAbstractFileByPath(path);
			if (file && isTFile(file)) {
				const text = await app.vault.cachedRead(file);
				return {
					content: [{ type: "text", text: `# ${path}\n\n${text}` }],
					details: {
						date,
						path,
						exists: true,
						bytes: text.length,
						folder,
						format,
					},
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							`No daily note for ${date} yet. Resolved path: \`${path}\`. ` +
							`Use create_note if you want to start one.`,
					},
				],
				details: { date, path, exists: false, bytes: 0, folder, format },
			};
		},
	};
}

function formatToday(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function parseIsoDate(iso: string): Date | null {
	const [y, m, d] = iso.split("-").map((s) => Number.parseInt(s, 10));
	if (!y || !m || !d) return null;
	const dt = new Date(y, m - 1, d);
	if (
		dt.getFullYear() !== y ||
		dt.getMonth() !== m - 1 ||
		dt.getDate() !== d
	) {
		return null;
	}
	return dt;
}

interface DailyNotesConfig {
	folder: string;
	format: string;
}

function resolveDailyNotesConfig(app: App): DailyNotesConfig {
	const internalPlugins = (app as unknown as {
		internalPlugins?: {
			getPluginById?: (id: string) => {
				enabled?: boolean;
				instance?: { options?: { folder?: string; format?: string } };
			} | null;
		};
	}).internalPlugins;
	const plugin = internalPlugins?.getPluginById?.("daily-notes");
	if (plugin?.enabled) {
		const opts = plugin.instance?.options ?? {};
		return {
			folder: typeof opts.folder === "string" ? opts.folder : "",
			format: typeof opts.format === "string" && opts.format.length > 0
				? opts.format
				: "YYYY-MM-DD",
		};
	}
	return { folder: "", format: "YYYY-MM-DD" };
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

function formatMomentLike(date: Date, format: string): string {
	// Match longest tokens first so e.g. `YYYY` wins over `YY`.
	const tokenRegex =
		/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd/g;
	return format.replace(tokenRegex, (match, literal) => {
		if (literal !== undefined) return literal;
		switch (match) {
			case "YYYY":
				return String(date.getFullYear());
			case "YY":
				return String(date.getFullYear()).slice(-2);
			case "MMMM":
				return MONTH_NAMES[date.getMonth()] ?? "";
			case "MMM":
				return (MONTH_NAMES[date.getMonth()] ?? "").slice(0, 3);
			case "MM":
				return String(date.getMonth() + 1).padStart(2, "0");
			case "M":
				return String(date.getMonth() + 1);
			case "DD":
				return String(date.getDate()).padStart(2, "0");
			case "D":
				return String(date.getDate());
			case "dddd":
				return DAY_NAMES[date.getDay()] ?? "";
			case "ddd":
				return (DAY_NAMES[date.getDay()] ?? "").slice(0, 3);
			default:
				return match;
		}
	});
}

const GetHeadingsParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the note, with extension (e.g. 'inbox/today.md').",
	}),
});

export interface HeadingEntry {
	text: string;
	level: number;
	line: number;
}

export interface GetHeadingsDetails {
	path: string;
	count: number;
	headings: HeadingEntry[];
}

export function getHeadingsTool(
	app: App,
): AgentTool<typeof GetHeadingsParams, GetHeadingsDetails> {
	return {
		name: "get_headings",
		label: "Get headings",
		description:
			"Return the heading outline of a note: each heading's text, level (1–6), and 0-based line number. " +
			"Useful before structural edits — e.g. find the line range under a heading before editing.",
		parameters: GetHeadingsParams,
		executionMode: "parallel",
		execute: async (
			_toolCallId: string,
			params: Static<typeof GetHeadingsParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			const cache = app.metadataCache.getFileCache(file);
			const raw = cache?.headings ?? [];
			const headings: HeadingEntry[] = raw.map((h) => ({
				text: h.heading,
				level: h.level,
				line: h.position?.start?.line ?? 0,
			}));
			const text = renderHeadings(file.path, headings);
			return {
				content: [{ type: "text", text }],
				details: { path: file.path, count: headings.length, headings },
			};
		},
	};
}

function renderHeadings(path: string, headings: HeadingEntry[]): string {
	if (headings.length === 0) {
		return `[[${path}]] has no headings.`;
	}
	const header = `${headings.length} heading${headings.length === 1 ? "" : "s"} in [[${path}]]:`;
	const lines = headings.map((h) => {
		const indent = "  ".repeat(Math.max(0, h.level - 1));
		return `${indent}- ${h.text} (line ${h.line + 1}, h${h.level})`;
	});
	return `${header}\n${lines.join("\n")}`;
}

const TrashNoteParams = Type.Object({
	path: Type.String({
		description:
			"Vault-relative path to the note to trash, with extension (e.g. 'inbox/old.md').",
	}),
});

export interface TrashNoteDetails {
	path: string;
	bytes: number;
}

export function trashNoteTool(
	app: App,
): AgentTool<typeof TrashNoteParams, TrashNoteDetails> {
	return {
		name: "trash_note",
		label: "Move note to trash",
		description:
			"Move a note to the system trash (recoverable on most platforms). " +
			"This is the only way to delete files — there is no permanent-delete tool. " +
			"Every trash_note call requires explicit user approval before it takes effect.",
		parameters: TrashNoteParams,
		executionMode: "sequential",
		execute: async (
			_toolCallId: string,
			params: Static<typeof TrashNoteParams>,
		) => {
			const file = app.vault.getAbstractFileByPath(params.path);
			if (!file) {
				throw new Error(`No file at vault path: ${params.path}`);
			}
			if (!isTFile(file)) {
				throw new Error(`Path is a folder, not a file: ${params.path}`);
			}
			const before = await app.vault.cachedRead(file);
			await app.vault.trash(file, true);
			return {
				content: [
					{
						type: "text",
						text: `Moved ${params.path} to trash (${before.length} chars).`,
					},
				],
				details: { path: params.path, bytes: before.length },
			};
		},
	};
}
