import type { App } from "obsidian";

interface MockStat {
	ctime: number;
	mtime: number;
	size: number;
}

export interface MockHeading {
	heading: string;
	level: number;
	line: number;
}

export interface MockDailyNotesConfig {
	enabled: boolean;
	folder?: string;
	format?: string;
}

export interface MockFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat: MockStat;
	parent: MockFolder | null;
}

export interface MockFolder {
	path: string;
	name: string;
	children: Array<MockFile | MockFolder>;
	parent: MockFolder | null;
}

export type MockEntry = MockFile | MockFolder;

export function isMockFolder(entry: MockEntry): entry is MockFolder {
	return "children" in entry;
}

export class MockVault {
	private root: MockFolder = {
		path: "",
		name: "",
		children: [],
		parent: null,
	};
	private entries = new Map<string, MockEntry>([["", this.root]]);
	private contents = new Map<string, string>();
	private frontmatter = new Map<string, Record<string, unknown>>();
	private headings = new Map<string, MockHeading[]>();
	private inlineTags = new Map<string, string[]>();
	resolvedLinks: Record<string, Record<string, number>> = {};

	addFile(path: string, content = ""): MockFile {
		if (this.entries.has(path)) {
			throw new Error(`Mock: file already exists at ${path}`);
		}
		const segments = path.split("/").filter(Boolean);
		if (segments.length === 0) {
			throw new Error("Mock: empty path");
		}
		const fileName = segments.pop()!;
		const parent =
			segments.length === 0
				? this.root
				: this.ensureFolder(segments.join("/"));
		const dotIdx = fileName.lastIndexOf(".");
		const basename = dotIdx === -1 ? fileName : fileName.slice(0, dotIdx);
		const extension = dotIdx === -1 ? "" : fileName.slice(dotIdx + 1);
		const file: MockFile = {
			path,
			name: fileName,
			basename,
			extension,
			stat: { ctime: 0, mtime: 0, size: content.length },
			parent,
		};
		parent.children.push(file);
		this.entries.set(path, file);
		this.contents.set(path, content);
		return file;
	}

	addFolder(path: string): MockFolder {
		return this.ensureFolder(path);
	}

	private ensureFolder(folderPath: string): MockFolder {
		const existing = this.entries.get(folderPath);
		if (existing) {
			if (!isMockFolder(existing)) {
				throw new Error(`Mock: path is a file, not a folder: ${folderPath}`);
			}
			return existing;
		}
		const segments = folderPath.split("/").filter(Boolean);
		let parent = this.root;
		let cumulative = "";
		for (const seg of segments) {
			cumulative = cumulative === "" ? seg : `${cumulative}/${seg}`;
			const exists = this.entries.get(cumulative);
			if (exists) {
				if (!isMockFolder(exists)) {
					throw new Error(`Mock: path is a file, not a folder: ${cumulative}`);
				}
				parent = exists;
				continue;
			}
			const folder: MockFolder = {
				path: cumulative,
				name: seg,
				children: [],
				parent,
			};
			parent.children.push(folder);
			this.entries.set(cumulative, folder);
			parent = folder;
		}
		return parent;
	}

	getMarkdownFiles(): MockFile[] {
		const out: MockFile[] = [];
		for (const entry of this.entries.values()) {
			if (!isMockFolder(entry) && entry.extension === "md") out.push(entry);
		}
		return out;
	}

	getAbstractFileByPath(path: string): MockEntry | null {
		if (path === "/" || path === "") return this.root;
		return this.entries.get(path) ?? null;
	}

	getRoot(): MockFolder {
		return this.root;
	}

	cachedRead(file: MockFile): Promise<string> {
		return Promise.resolve(this.contents.get(file.path) ?? "");
	}

	async process(
		file: MockFile,
		fn: (data: string) => string,
	): Promise<string> {
		const data = this.contents.get(file.path) ?? "";
		const next = fn(data);
		this.contents.set(file.path, next);
		return next;
	}

	async create(path: string, content: string): Promise<MockFile> {
		return this.addFile(path, content);
	}

	async createFolder(path: string): Promise<MockFolder> {
		const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
		if (normalized.length === 0) {
			throw new Error("Mock: cannot create empty folder path");
		}
		if (this.entries.has(normalized)) {
			throw new Error(`Mock: path already exists: ${normalized}`);
		}
		return this.ensureFolder(normalized);
	}

	async trash(file: MockFile, _system: boolean): Promise<void> {
		if (!this.entries.has(file.path)) {
			throw new Error(`Mock: file not found: ${file.path}`);
		}
		this.entries.delete(file.path);
		this.contents.delete(file.path);
		const parent = file.parent;
		if (parent) {
			parent.children = parent.children.filter((c) => c !== file);
		}
	}

	hasEntry(path: string): boolean {
		return this.entries.has(path);
	}

	async renameFile(file: MockFile, newPath: string): Promise<void> {
		if (!this.entries.has(file.path)) {
			throw new Error(`Mock: file not found: ${file.path}`);
		}
		if (this.entries.has(newPath)) {
			throw new Error(`Mock: target already exists: ${newPath}`);
		}
		const oldPath = file.path;
		const content = this.contents.get(oldPath) ?? "";
		const fm = this.frontmatter.get(oldPath);
		this.contents.delete(oldPath);
		this.frontmatter.delete(oldPath);
		this.entries.delete(oldPath);
		const oldParent = file.parent;
		if (oldParent) {
			oldParent.children = oldParent.children.filter((c) => c !== file);
		}
		const slash = newPath.lastIndexOf("/");
		const newParent =
			slash === -1 ? this.root : this.ensureFolder(newPath.slice(0, slash));
		const fileName = slash === -1 ? newPath : newPath.slice(slash + 1);
		const dotIdx = fileName.lastIndexOf(".");
		file.path = newPath;
		file.name = fileName;
		file.basename = dotIdx === -1 ? fileName : fileName.slice(0, dotIdx);
		file.extension = dotIdx === -1 ? "" : fileName.slice(dotIdx + 1);
		file.parent = newParent;
		newParent.children.push(file);
		this.entries.set(newPath, file);
		this.contents.set(newPath, content);
		if (fm) this.frontmatter.set(newPath, fm);
	}

	async processFrontMatter(
		file: MockFile,
		fn: (fm: Record<string, unknown>) => void,
	): Promise<void> {
		if (!this.entries.has(file.path)) {
			throw new Error(`Mock: file not found: ${file.path}`);
		}
		const fm = this.frontmatter.get(file.path) ?? {};
		fn(fm);
		this.frontmatter.set(file.path, fm);
	}

	getFrontmatter(path: string): Record<string, unknown> | undefined {
		return this.frontmatter.get(path);
	}

	setFrontmatter(path: string, fm: Record<string, unknown>): void {
		this.frontmatter.set(path, fm);
	}

	setHeadings(path: string, headings: MockHeading[]): void {
		this.headings.set(path, headings);
	}

	getHeadings(path: string): MockHeading[] | undefined {
		return this.headings.get(path);
	}

	setInlineTags(path: string, tags: string[]): void {
		this.inlineTags.set(path, tags);
	}

	getInlineTags(path: string): string[] | undefined {
		return this.inlineTags.get(path);
	}

	setResolvedLinks(source: string, targets: Record<string, number>): void {
		this.resolvedLinks[source] = targets;
	}
}

export interface MockAppHandle {
	app: App;
	vault: MockVault;
	setActive(path: string | null): void;
	setDailyNotesConfig(config: MockDailyNotesConfig | null): void;
	hideFromMetadataCache(prefix: string): void;
}

export function createMockApp(): MockAppHandle {
	const vault = new MockVault();
	let activePath: string | null = null;
	let dailyNotesConfig: MockDailyNotesConfig | null = null;
	const hiddenPrefixes: string[] = [];
	const isHidden = (path: string) =>
		hiddenPrefixes.some(
			(p) => path === p || path.startsWith(`${p}/`),
		);
	const workspace = {
		getActiveFile: () => {
			if (activePath === null) return null;
			const f = vault.getAbstractFileByPath(activePath);
			if (!f || isMockFolder(f)) return null;
			return f;
		},
	};
	const fileManager = {
		renameFile: (file: MockFile, newPath: string) => vault.renameFile(file, newPath),
		processFrontMatter: (
			file: MockFile,
			fn: (fm: Record<string, unknown>) => void,
		) => vault.processFrontMatter(file, fn),
	};
	// Capture raw lookup BEFORE we install the hide-filter override below, so
	// the adapter always sees ground truth (it models the on-disk filesystem,
	// not Obsidian's metadata cache).
	const rawGet = vault.getAbstractFileByPath.bind(vault);
	const adapter = {
		exists: async (path: string) => vault.hasEntry(path),
		read: async (path: string) => {
			const entry = rawGet(path);
			if (!entry || isMockFolder(entry)) {
				throw new Error(`Mock: not a file: ${path}`);
			}
			return vault.cachedRead(entry);
		},
		write: async (path: string, data: string) => {
			const existing = rawGet(path);
			if (existing && !isMockFolder(existing)) {
				await vault.process(existing, () => data);
				return;
			}
			if (existing) {
				throw new Error(`Mock: path is a folder: ${path}`);
			}
			const slash = path.lastIndexOf("/");
			if (slash > 0) {
				const parent = path.slice(0, slash);
				if (!vault.hasEntry(parent)) {
					await vault.createFolder(parent);
				}
			}
			await vault.create(path, data);
		},
		list: async (path: string) => {
			const folder = rawGet(path);
			if (!folder || !isMockFolder(folder)) {
				return { files: [] as string[], folders: [] as string[] };
			}
			const files: string[] = [];
			const folders: string[] = [];
			for (const child of folder.children) {
				if (isMockFolder(child)) folders.push(child.path);
				else files.push(child.path);
			}
			return { files, folders };
		},
		stat: async (path: string) => {
			const entry = rawGet(path);
			if (!entry || isMockFolder(entry)) return null;
			return { mtime: entry.stat.mtime };
		},
		trashSystem: async (path: string) => {
			const entry = rawGet(path);
			if (!entry || isMockFolder(entry)) return false;
			await vault.trash(entry, true);
			return true;
		},
		trashLocal: async (path: string) => {
			const entry = rawGet(path);
			if (!entry || isMockFolder(entry)) {
				throw new Error(`Mock: not a file: ${path}`);
			}
			await vault.trash(entry, false);
		},
		remove: async (path: string) => {
			const entry = rawGet(path);
			if (!entry || isMockFolder(entry)) {
				throw new Error(`Mock: not a file: ${path}`);
			}
			await vault.trash(entry, true);
		},
	};
	const metadataCache = {
		get resolvedLinks() {
			return vault.resolvedLinks;
		},
		getFileCache: (file: MockFile) => {
			const path = file.path;
			const headings = vault.getHeadings(path);
			const fm = vault.getFrontmatter(path);
			const inline = vault.getInlineTags(path);
			const cache: Record<string, unknown> = {};
			if (headings && headings.length > 0) {
				cache.headings = headings.map((h) => ({
					heading: h.heading,
					level: h.level,
					position: {
						start: { line: h.line, col: 0, offset: 0 },
						end: { line: h.line, col: 0, offset: 0 },
					},
				}));
			}
			if (fm) cache.frontmatter = fm;
			if (inline && inline.length > 0) {
				cache.tags = inline.map((t, i) => ({
					tag: t.startsWith("#") ? t : `#${t}`,
					position: {
						start: { line: i, col: 0, offset: 0 },
						end: { line: i, col: 0, offset: 0 },
					},
				}));
			}
			return cache;
		},
	};
	const internalPlugins = {
		getPluginById: (id: string) => {
			if (id !== "daily-notes" || !dailyNotesConfig) return null;
			return {
				enabled: dailyNotesConfig.enabled,
				instance: {
					options: {
						folder: dailyNotesConfig.folder ?? "",
						format: dailyNotesConfig.format ?? "YYYY-MM-DD",
					},
				},
			};
		},
	};
	vault.getAbstractFileByPath = (path: string) => {
		if (isHidden(path)) return null;
		return rawGet(path);
	};
	const rawGetMarkdown = vault.getMarkdownFiles.bind(vault);
	vault.getMarkdownFiles = () =>
		rawGetMarkdown().filter((f) => !isHidden(f.path));
	(vault as unknown as { adapter: unknown }).adapter = adapter;
	const app = {
		vault,
		workspace,
		fileManager,
		metadataCache,
		internalPlugins,
	} as unknown as App;
	return {
		app,
		vault,
		setActive: (path) => {
			activePath = path;
		},
		setDailyNotesConfig: (config) => {
			dailyNotesConfig = config;
		},
		hideFromMetadataCache: (prefix) => {
			hiddenPrefixes.push(prefix);
		},
	};
}
