import { describe, expect, it } from "vitest";
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
	type AddTagDetails,
	type AppendNoteDetails,
	type CreateNoteDetails,
	type GetBacklinksDetails,
	type GetDailyNoteDetails,
	type GetHeadingsDetails,
	type GetNotesByTagDetails,
	type ListFolderDetails,
	type MoveNoteDetails,
	type SearchVaultDetails,
	type SetFrontmatterDetails,
	type TrashNoteDetails,
} from "../src/vault-tools";
import { createMockApp } from "./mock-obsidian";

describe("read_note", () => {
	it("returns file contents and byte count", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("inbox.md", "hello world");
		const tool = readNoteTool(app);
		const result = await tool.execute("call-1", { path: "inbox.md" });
		expect(result.content[0]).toEqual({ type: "text", text: "hello world" });
		expect(result.details).toEqual({ path: "inbox.md", bytes: 11 });
	});

	it("throws on missing path", async () => {
		const { app } = createMockApp();
		const tool = readNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "missing.md" }),
		).rejects.toThrow(/No file at vault path/);
	});

	it("throws when path is a folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFolder("projects");
		const tool = readNoteTool(app);
		await expect(tool.execute("call-1", { path: "projects" })).rejects.toThrow(
			/folder, not a file/,
		);
	});
});

describe("edit_note", () => {
	it("replaces a unique occurrence and reports byte delta", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "alpha bravo charlie");
		const tool = editNoteTool(app);
		const result = await tool.execute("call-1", {
			path: "note.md",
			old: "bravo",
			new: "BRAVO!",
		});
		expect(result.details.bytesBefore).toBe(19);
		expect(result.details.bytesAfter).toBe(20);
		const after = await app.vault.cachedRead(
			app.vault.getAbstractFileByPath("note.md") as never,
		);
		expect(after).toBe("alpha BRAVO! charlie");
	});

	it("fails when old text is missing", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "alpha bravo");
		const tool = editNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "note.md", old: "delta", new: "x" }),
		).rejects.toThrow(/was not found/);
	});

	it("fails when old text appears more than once", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "echo echo");
		const tool = editNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "note.md", old: "echo", new: "x" }),
		).rejects.toThrow(/more than once/);
	});

	it("rejects empty old string", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "hello");
		const tool = editNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "note.md", old: "", new: "x" }),
		).rejects.toThrow(/non-empty/);
	});
});

describe("search_vault", () => {
	it("finds matches in a single file with line number and snippet", async () => {
		const { app, vault } = createMockApp();
		vault.addFile(
			"note.md",
			"line one\nthis is about React hooks\nline three",
		);
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", { query: "react" });
		const details = result.details as SearchVaultDetails;
		expect(details.matches).toHaveLength(1);
		expect(details.matches[0]?.path).toBe("note.md");
		expect(details.matches[0]?.line).toBe(2);
		expect(details.matches[0]?.snippet).toContain("React hooks");
	});

	it("scans across multiple files and reports total scanned", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "hello world");
		vault.addFile("b.md", "WORLD peace");
		vault.addFile("c.md", "nothing here");
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", { query: "world" });
		const details = result.details as SearchVaultDetails;
		expect(details.matches.map((m) => m.path).sort()).toEqual(["a.md", "b.md"]);
		expect(details.totalScanned).toBe(3);
	});

	it("respects scope folder prefix", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("projects/alpha.md", "find me");
		vault.addFile("projects/sub/beta.md", "find me too");
		vault.addFile("inbox.md", "find me as well");
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", {
			query: "find",
			scope: "projects",
		});
		const details = result.details as SearchVaultDetails;
		expect(details.matches.map((m) => m.path).sort()).toEqual([
			"projects/alpha.md",
			"projects/sub/beta.md",
		]);
		expect(details.scope).toBe("projects/");
	});

	it("normalizes trailing slash in scope", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("projects/alpha.md", "find me");
		vault.addFile("inbox.md", "find me too");
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", {
			query: "find",
			scope: "projects/",
		});
		expect((result.details as SearchVaultDetails).matches).toHaveLength(1);
	});

	it("returns empty matches with a helpful message", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "hello");
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", { query: "absent" });
		expect((result.details as SearchVaultDetails).matches).toHaveLength(0);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toMatch(
			/No matches for "absent"/,
		);
	});

	it("honors maxResults", async () => {
		const { app, vault } = createMockApp();
		for (let i = 0; i < 5; i++) vault.addFile(`f${i}.md`, "needle");
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", {
			query: "needle",
			maxResults: 3,
		});
		expect((result.details as SearchVaultDetails).matches).toHaveLength(3);
	});

	it("rejects empty query", async () => {
		const { app } = createMockApp();
		const tool = searchVaultTool(app);
		await expect(tool.execute("call-1", { query: "" })).rejects.toThrow(
			/non-empty/,
		);
	});

	it("renders results as wiki-links so they're clickable in chat", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("projects/alpha.md", "find me");
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", { query: "find" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("[[projects/alpha.md]]");
		expect(text).toContain("line 1");
	});

	it("skips non-markdown files", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("image.png", "find me");
		vault.addFile("note.md", "find me");
		const tool = searchVaultTool(app);
		const result = await tool.execute("call-1", { query: "find" });
		expect((result.details as SearchVaultDetails).matches.map((m) => m.path)).toEqual([
			"note.md",
		]);
	});
});

describe("get_active_note", () => {
	it("returns the active markdown file's path and content", async () => {
		const { app, vault, setActive } = createMockApp();
		vault.addFile("inbox.md", "today's notes");
		setActive("inbox.md");
		const tool = getActiveNoteTool(app);
		const result = await tool.execute("call-1", {});
		expect(result.details).toEqual({ path: "inbox.md", bytes: 13 });
		expect((result.content[0] as { text: string }).text).toContain("today's notes");
		expect((result.content[0] as { text: string }).text).toContain("# inbox.md");
	});

	it("throws when no file is active", async () => {
		const { app } = createMockApp();
		const tool = getActiveNoteTool(app);
		await expect(tool.execute("call-1", {})).rejects.toThrow(
			/No file is currently active/,
		);
	});

	it("throws when active file is not markdown", async () => {
		const { app, vault, setActive } = createMockApp();
		vault.addFile("diagram.canvas", "{}");
		setActive("diagram.canvas");
		const tool = getActiveNoteTool(app);
		await expect(tool.execute("call-1", {})).rejects.toThrow(
			/not a markdown note/,
		);
	});
});

describe("list_folder", () => {
	it("lists direct children of a folder, folders first", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("projects/alpha.md", "");
		vault.addFile("projects/beta.md", "");
		vault.addFolder("projects/sub");
		const tool = listFolderTool(app);
		const result = await tool.execute("call-1", { path: "projects" });
		const details = result.details as ListFolderDetails;
		expect(details.entries).toEqual([
			{ path: "projects/sub", kind: "folder" },
			{ path: "projects/alpha.md", kind: "file" },
			{ path: "projects/beta.md", kind: "file" },
		]);
		expect(details.count).toBe(3);
	});

	it("returns the vault root when path is empty", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("inbox.md", "");
		vault.addFolder("projects");
		const tool = listFolderTool(app);
		const result = await tool.execute("call-1", { path: "" });
		const details = result.details as ListFolderDetails;
		expect(details.path).toBe("");
		expect(details.entries.map((e) => e.path).sort()).toEqual([
			"inbox.md",
			"projects",
		]);
	});

	it("returns the vault root when path is '/'", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("inbox.md", "");
		const tool = listFolderTool(app);
		const result = await tool.execute("call-1", { path: "/" });
		expect((result.details as ListFolderDetails).entries).toEqual([
			{ path: "inbox.md", kind: "file" },
		]);
	});

	it("walks all descendants with recursive=true", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("projects/alpha.md", "");
		vault.addFile("projects/sub/beta.md", "");
		const tool = listFolderTool(app);
		const result = await tool.execute("call-1", {
			path: "projects",
			recursive: true,
		});
		const paths = (result.details as ListFolderDetails).entries
			.map((e) => e.path)
			.sort();
		expect(paths).toEqual([
			"projects/alpha.md",
			"projects/sub",
			"projects/sub/beta.md",
		]);
	});

	it("returns an empty listing for an empty folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFolder("empty");
		const tool = listFolderTool(app);
		const result = await tool.execute("call-1", { path: "empty" });
		expect((result.details as ListFolderDetails).count).toBe(0);
		expect((result.content[0] as { text: string }).text).toMatch(/is empty/);
	});

	it("throws on missing folder", async () => {
		const { app } = createMockApp();
		const tool = listFolderTool(app);
		await expect(tool.execute("call-1", { path: "ghost" })).rejects.toThrow(
			/No folder at vault path/,
		);
	});

	it("throws when path is a file", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		const tool = listFolderTool(app);
		await expect(tool.execute("call-1", { path: "note.md" })).rejects.toThrow(
			/file, not a folder/,
		);
	});

	it("strips leading/trailing slashes from path", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("projects/a.md", "");
		const tool = listFolderTool(app);
		const result = await tool.execute("call-1", { path: "/projects/" });
		expect((result.details as ListFolderDetails).count).toBe(1);
	});
});

describe("create_note", () => {
	it("creates a new note with content at the vault root", async () => {
		const { app, vault } = createMockApp();
		const tool = createNoteTool(app);
		const result = await tool.execute("call-1", {
			path: "inbox.md",
			content: "first line",
		});
		const details = result.details as CreateNoteDetails;
		expect(details.path).toBe("inbox.md");
		expect(details.bytes).toBe(10);
		expect(vault.hasEntry("inbox.md")).toBe(true);
		expect(
			await app.vault.cachedRead(
				app.vault.getAbstractFileByPath("inbox.md") as never,
			),
		).toBe("first line");
	});

	it("auto-creates missing parent folders", async () => {
		const { app, vault } = createMockApp();
		const tool = createNoteTool(app);
		await tool.execute("call-1", {
			path: "projects/sub/new.md",
			content: "hi",
		});
		expect(vault.hasEntry("projects")).toBe(true);
		expect(vault.hasEntry("projects/sub")).toBe(true);
		expect(vault.hasEntry("projects/sub/new.md")).toBe(true);
	});

	it("rejects an existing path", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("inbox.md", "x");
		const tool = createNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "inbox.md", content: "y" }),
		).rejects.toThrow(/already exists/);
	});

	it("rejects an empty path", async () => {
		const { app } = createMockApp();
		const tool = createNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "", content: "x" }),
		).rejects.toThrow(/non-empty/);
	});

	it("strips a leading slash from the path", async () => {
		const { app, vault } = createMockApp();
		const tool = createNoteTool(app);
		const result = await tool.execute("call-1", {
			path: "/inbox.md",
			content: "y",
		});
		expect((result.details as CreateNoteDetails).path).toBe("inbox.md");
		expect(vault.hasEntry("inbox.md")).toBe(true);
	});

	it("creates an empty note when content is empty", async () => {
		const { app, vault } = createMockApp();
		const tool = createNoteTool(app);
		const result = await tool.execute("call-1", {
			path: "empty.md",
			content: "",
		});
		expect((result.details as CreateNoteDetails).bytes).toBe(0);
		expect(vault.hasEntry("empty.md")).toBe(true);
	});

	it("rejects when parent path is an existing file", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("notes.md", "x");
		const tool = createNoteTool(app);
		await expect(
			tool.execute("call-1", {
				path: "notes.md/inner.md",
				content: "y",
			}),
		).rejects.toThrow(/file, not a folder/);
	});
});

describe("append_note", () => {
	it("appends with an inserted newline when file doesn't end with one", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("log.md", "first");
		const tool = appendNoteTool(app);
		const result = await tool.execute("call-1", {
			path: "log.md",
			text: "second",
		});
		const details = result.details as AppendNoteDetails;
		expect(details.bytesBefore).toBe(5);
		expect(details.bytesAfter).toBe(12);
		const after = await app.vault.cachedRead(
			app.vault.getAbstractFileByPath("log.md") as never,
		);
		expect(after).toBe("first\nsecond");
	});

	it("does not double-newline when file already ends in a newline", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("log.md", "first\n");
		const tool = appendNoteTool(app);
		await tool.execute("call-1", { path: "log.md", text: "second" });
		const after = await app.vault.cachedRead(
			app.vault.getAbstractFileByPath("log.md") as never,
		);
		expect(after).toBe("first\nsecond");
	});

	it("writes plain text into an empty file without leading newline", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("log.md", "");
		const tool = appendNoteTool(app);
		await tool.execute("call-1", { path: "log.md", text: "hello" });
		const after = await app.vault.cachedRead(
			app.vault.getAbstractFileByPath("log.md") as never,
		);
		expect(after).toBe("hello");
	});

	it("fails when the target doesn't exist", async () => {
		const { app } = createMockApp();
		const tool = appendNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "missing.md", text: "x" }),
		).rejects.toThrow(/No file at vault path/);
	});

	it("fails when the path is a folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFolder("projects");
		const tool = appendNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "projects", text: "x" }),
		).rejects.toThrow(/folder, not a file/);
	});

	it("rejects empty text", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("log.md", "x");
		const tool = appendNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "log.md", text: "" }),
		).rejects.toThrow(/non-empty/);
	});
});

describe("trash_note", () => {
	it("removes the file from the vault and reports its byte count", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("old.md", "doomed");
		const tool = trashNoteTool(app);
		const result = await tool.execute("call-1", { path: "old.md" });
		const details = result.details as TrashNoteDetails;
		expect(details.path).toBe("old.md");
		expect(details.bytes).toBe(6);
		expect(vault.hasEntry("old.md")).toBe(false);
		expect(app.vault.getAbstractFileByPath("old.md")).toBeNull();
	});

	it("fails on missing path", async () => {
		const { app } = createMockApp();
		const tool = trashNoteTool(app);
		await expect(tool.execute("call-1", { path: "ghost.md" })).rejects.toThrow(
			/No file at vault path/,
		);
	});

	it("fails when the path is a folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFolder("projects");
		const tool = trashNoteTool(app);
		await expect(tool.execute("call-1", { path: "projects" })).rejects.toThrow(
			/folder, not a file/,
		);
	});
});

describe("move_note", () => {
	it("renames within the same folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("inbox/today.md", "hi");
		const tool = moveNoteTool(app);
		const result = await tool.execute("call-1", {
			path: "inbox/today.md",
			newPath: "inbox/2026-05-14.md",
		});
		expect((result.details as MoveNoteDetails).newPath).toBe(
			"inbox/2026-05-14.md",
		);
		expect(vault.hasEntry("inbox/today.md")).toBe(false);
		expect(vault.hasEntry("inbox/2026-05-14.md")).toBe(true);
		expect(
			await app.vault.cachedRead(
				app.vault.getAbstractFileByPath("inbox/2026-05-14.md") as never,
			),
		).toBe("hi");
	});

	it("moves across folders and auto-creates missing parents", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("inbox/scratch.md", "x");
		const tool = moveNoteTool(app);
		await tool.execute("call-1", {
			path: "inbox/scratch.md",
			newPath: "projects/alpha/scratch.md",
		});
		expect(vault.hasEntry("projects")).toBe(true);
		expect(vault.hasEntry("projects/alpha")).toBe(true);
		expect(vault.hasEntry("projects/alpha/scratch.md")).toBe(true);
	});

	it("strips a leading slash from newPath", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		const tool = moveNoteTool(app);
		const result = await tool.execute("call-1", {
			path: "a.md",
			newPath: "/b.md",
		});
		expect((result.details as MoveNoteDetails).newPath).toBe("b.md");
	});

	it("rejects when source is missing", async () => {
		const { app } = createMockApp();
		const tool = moveNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "ghost.md", newPath: "elsewhere.md" }),
		).rejects.toThrow(/No file at vault path/);
	});

	it("rejects when target already exists", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		vault.addFile("b.md", "");
		const tool = moveNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "a.md", newPath: "b.md" }),
		).rejects.toThrow(/already exists/);
	});

	it("rejects self-move", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		const tool = moveNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "a.md", newPath: "a.md" }),
		).rejects.toThrow(/same as the current path/);
	});

	it("rejects empty newPath", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		const tool = moveNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "a.md", newPath: "" }),
		).rejects.toThrow(/non-empty/);
	});

	it("rejects when source is a folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFolder("projects");
		const tool = moveNoteTool(app);
		await expect(
			tool.execute("call-1", { path: "projects", newPath: "renamed" }),
		).rejects.toThrow(/folder, not a file/);
	});
});

describe("set_frontmatter", () => {
	it("sets a new key when frontmatter is empty", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		const tool = setFrontmatterTool(app);
		const result = await tool.execute("call-1", {
			path: "note.md",
			key: "status",
			value: "in-progress",
		});
		const details = result.details as SetFrontmatterDetails;
		expect(details.removed).toBe(false);
		expect(details.previousValue).toBeUndefined();
		expect(vault.getFrontmatter("note.md")).toEqual({ status: "in-progress" });
	});

	it("overwrites an existing key and reports the previous value", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		vault.setFrontmatter("note.md", { status: "todo" });
		const tool = setFrontmatterTool(app);
		const result = await tool.execute("call-1", {
			path: "note.md",
			key: "status",
			value: "done",
		});
		expect((result.details as SetFrontmatterDetails).previousValue).toBe("todo");
		expect(vault.getFrontmatter("note.md")).toEqual({ status: "done" });
	});

	it("removes a key when value is null", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		vault.setFrontmatter("note.md", { draft: true, status: "todo" });
		const tool = setFrontmatterTool(app);
		const result = await tool.execute("call-1", {
			path: "note.md",
			key: "draft",
			value: null,
		});
		expect((result.details as SetFrontmatterDetails).removed).toBe(true);
		expect(vault.getFrontmatter("note.md")).toEqual({ status: "todo" });
	});

	it("preserves arrays and nested objects", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		const tool = setFrontmatterTool(app);
		await tool.execute("call-1", {
			path: "note.md",
			key: "meta",
			value: { owner: "subhan", priority: 2, tags: ["a", "b"] },
		});
		expect(vault.getFrontmatter("note.md")).toEqual({
			meta: { owner: "subhan", priority: 2, tags: ["a", "b"] },
		});
	});

	it("rejects empty key", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		const tool = setFrontmatterTool(app);
		await expect(
			tool.execute("call-1", { path: "note.md", key: "", value: "x" }),
		).rejects.toThrow(/non-empty/);
	});

	it("rejects missing file", async () => {
		const { app } = createMockApp();
		const tool = setFrontmatterTool(app);
		await expect(
			tool.execute("call-1", { path: "ghost.md", key: "k", value: "v" }),
		).rejects.toThrow(/No file at vault path/);
	});
});

describe("add_tag", () => {
	it("adds a tag to an empty frontmatter", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		const tool = addTagTool(app);
		const result = await tool.execute("call-1", {
			path: "note.md",
			tag: "project",
		});
		const details = result.details as AddTagDetails;
		expect(details.alreadyPresent).toBe(false);
		expect(details.tags).toEqual(["project"]);
		expect(vault.getFrontmatter("note.md")).toEqual({ tags: ["project"] });
	});

	it("strips leading `#` from the tag", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		const tool = addTagTool(app);
		await tool.execute("call-1", { path: "note.md", tag: "#area/work" });
		expect(vault.getFrontmatter("note.md")).toEqual({ tags: ["area/work"] });
	});

	it("appends to an existing array without duplicating", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		vault.setFrontmatter("note.md", { tags: ["alpha"] });
		const tool = addTagTool(app);
		const r1 = await tool.execute("call-1", {
			path: "note.md",
			tag: "beta",
		});
		expect((r1.details as AddTagDetails).tags).toEqual(["alpha", "beta"]);

		const r2 = await tool.execute("call-2", {
			path: "note.md",
			tag: "alpha",
		});
		expect((r2.details as AddTagDetails).alreadyPresent).toBe(true);
		expect((r2.details as AddTagDetails).tags).toEqual(["alpha", "beta"]);
	});

	it("upgrades a scalar tags value to an array", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		vault.setFrontmatter("note.md", { tags: "lonely" });
		const tool = addTagTool(app);
		await tool.execute("call-1", { path: "note.md", tag: "friend" });
		expect(vault.getFrontmatter("note.md")).toEqual({
			tags: ["lonely", "friend"],
		});
	});

	it("rejects empty tag after stripping `#`", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		const tool = addTagTool(app);
		await expect(
			tool.execute("call-1", { path: "note.md", tag: "###" }),
		).rejects.toThrow(/non-empty/);
	});

	it("rejects missing file", async () => {
		const { app } = createMockApp();
		const tool = addTagTool(app);
		await expect(
			tool.execute("call-1", { path: "ghost.md", tag: "x" }),
		).rejects.toThrow(/No file at vault path/);
	});
});

describe("get_backlinks", () => {
	it("returns sources that link to the target, sorted by count desc then path", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("target.md", "");
		vault.addFile("a.md", "");
		vault.addFile("b.md", "");
		vault.addFile("c.md", "");
		vault.setResolvedLinks("a.md", { "target.md": 1 });
		vault.setResolvedLinks("b.md", { "target.md": 3 });
		vault.setResolvedLinks("c.md", { "other.md": 5 });
		const tool = getBacklinksTool(app);
		const result = await tool.execute("call-1", { path: "target.md" });
		const details = result.details as GetBacklinksDetails;
		expect(details.count).toBe(2);
		expect(details.sources).toEqual([
			{ path: "b.md", count: 3 },
			{ path: "a.md", count: 1 },
		]);
	});

	it("renders results as wiki-links", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("target.md", "");
		vault.addFile("source.md", "");
		vault.setResolvedLinks("source.md", { "target.md": 2 });
		const tool = getBacklinksTool(app);
		const result = await tool.execute("call-1", { path: "target.md" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("[[source.md]]");
		expect(text).toContain("×2");
	});

	it("reports an empty-result message when no backlinks exist", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("lonely.md", "");
		const tool = getBacklinksTool(app);
		const result = await tool.execute("call-1", { path: "lonely.md" });
		expect((result.details as GetBacklinksDetails).count).toBe(0);
		expect((result.content[0] as { text: string }).text).toMatch(
			/No backlinks/,
		);
	});

	it("excludes self-links", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		vault.setResolvedLinks("a.md", { "a.md": 1 });
		const tool = getBacklinksTool(app);
		const result = await tool.execute("call-1", { path: "a.md" });
		expect((result.details as GetBacklinksDetails).count).toBe(0);
	});

	it("throws on missing target", async () => {
		const { app } = createMockApp();
		const tool = getBacklinksTool(app);
		await expect(tool.execute("call-1", { path: "ghost.md" })).rejects.toThrow(
			/No file at vault path/,
		);
	});

	it("throws when target is a folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFolder("projects");
		const tool = getBacklinksTool(app);
		await expect(
			tool.execute("call-1", { path: "projects" }),
		).rejects.toThrow(/folder, not a file/);
	});
});

describe("get_notes_by_tag", () => {
	it("finds notes via frontmatter tags array", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		vault.addFile("b.md", "");
		vault.setFrontmatter("a.md", { tags: ["project", "alpha"] });
		vault.setFrontmatter("b.md", { tags: ["beta"] });
		const tool = getNotesByTagTool(app);
		const result = await tool.execute("call-1", { tag: "project" });
		const details = result.details as GetNotesByTagDetails;
		expect(details.count).toBe(1);
		expect(details.notes[0]?.path).toBe("a.md");
	});

	it("finds notes via frontmatter scalar tag", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		vault.setFrontmatter("a.md", { tags: "solo" });
		const tool = getNotesByTagTool(app);
		const result = await tool.execute("call-1", { tag: "solo" });
		expect((result.details as GetNotesByTagDetails).count).toBe(1);
	});

	it("finds notes via inline tags", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "this is #urgent stuff");
		vault.setInlineTags("a.md", ["#urgent"]);
		const tool = getNotesByTagTool(app);
		const result = await tool.execute("call-1", { tag: "urgent" });
		expect((result.details as GetNotesByTagDetails).count).toBe(1);
	});

	it("matches nested sub-tags (parent matches children)", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		vault.addFile("b.md", "");
		vault.addFile("c.md", "");
		vault.setFrontmatter("a.md", { tags: ["area"] });
		vault.setFrontmatter("b.md", { tags: ["area/work"] });
		vault.setFrontmatter("c.md", { tags: ["area/home/sub"] });
		const tool = getNotesByTagTool(app);
		const result = await tool.execute("call-1", { tag: "area" });
		const paths = (result.details as GetNotesByTagDetails).notes
			.map((n) => n.path)
			.sort();
		expect(paths).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("does NOT cross-match unrelated tags with same prefix substring", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		vault.addFile("b.md", "");
		vault.setFrontmatter("a.md", { tags: ["area"] });
		vault.setFrontmatter("b.md", { tags: ["areacode"] });
		const tool = getNotesByTagTool(app);
		const result = await tool.execute("call-1", { tag: "area" });
		const paths = (result.details as GetNotesByTagDetails).notes.map(
			(n) => n.path,
		);
		expect(paths).toEqual(["a.md"]);
	});

	it("strips a leading `#` from the query", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		vault.setFrontmatter("a.md", { tags: ["project"] });
		const tool = getNotesByTagTool(app);
		const result = await tool.execute("call-1", { tag: "#project" });
		expect((result.details as GetNotesByTagDetails).count).toBe(1);
	});

	it("reports an empty-result message when nothing matches", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("a.md", "");
		const tool = getNotesByTagTool(app);
		const result = await tool.execute("call-1", { tag: "absent" });
		expect((result.details as GetNotesByTagDetails).count).toBe(0);
		expect((result.content[0] as { text: string }).text).toMatch(/No notes/);
	});

	it("rejects empty tag after stripping `#`", async () => {
		const { app } = createMockApp();
		const tool = getNotesByTagTool(app);
		await expect(tool.execute("call-1", { tag: "##" })).rejects.toThrow(
			/non-empty/,
		);
	});
});

describe("get_daily_note", () => {
	it("returns content when the daily note exists at the default path", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("2026-05-15.md", "today's log");
		const tool = getDailyNoteTool(app);
		const result = await tool.execute("call-1", { date: "2026-05-15" });
		const details = result.details as GetDailyNoteDetails;
		expect(details.exists).toBe(true);
		expect(details.path).toBe("2026-05-15.md");
		expect(details.bytes).toBe(11);
		expect((result.content[0] as { text: string }).text).toContain(
			"today's log",
		);
	});

	it("reports a missing daily note with the resolved path", async () => {
		const { app } = createMockApp();
		const tool = getDailyNoteTool(app);
		const result = await tool.execute("call-1", { date: "2026-05-15" });
		const details = result.details as GetDailyNoteDetails;
		expect(details.exists).toBe(false);
		expect(details.path).toBe("2026-05-15.md");
		expect((result.content[0] as { text: string }).text).toMatch(
			/No daily note/,
		);
	});

	it("uses the Daily Notes plugin folder + format when enabled", async () => {
		const { app, vault, setDailyNotesConfig } = createMockApp();
		setDailyNotesConfig({
			enabled: true,
			folder: "journal",
			format: "YYYY/MM-DD",
		});
		vault.addFile("journal/2026/05-15.md", "configured");
		const tool = getDailyNoteTool(app);
		const result = await tool.execute("call-1", { date: "2026-05-15" });
		const details = result.details as GetDailyNoteDetails;
		expect(details.path).toBe("journal/2026/05-15.md");
		expect(details.folder).toBe("journal");
		expect(details.format).toBe("YYYY/MM-DD");
		expect(details.exists).toBe(true);
	});

	it("falls back to defaults when the daily-notes plugin is disabled", async () => {
		const { app, setDailyNotesConfig } = createMockApp();
		setDailyNotesConfig({
			enabled: false,
			folder: "journal",
			format: "YYYY/MM-DD",
		});
		const tool = getDailyNoteTool(app);
		const result = await tool.execute("call-1", { date: "2026-05-15" });
		const details = result.details as GetDailyNoteDetails;
		expect(details.path).toBe("2026-05-15.md");
		expect(details.folder).toBe("");
		expect(details.format).toBe("YYYY-MM-DD");
	});

	it("defaults to today when no date is given", async () => {
		const { app } = createMockApp();
		const tool = getDailyNoteTool(app);
		const result = await tool.execute("call-1", {});
		const details = result.details as GetDailyNoteDetails;
		expect(details.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(details.path).toBe(`${details.date}.md`);
	});

	it("rejects a malformed date string", async () => {
		const { app } = createMockApp();
		const tool = getDailyNoteTool(app);
		await expect(
			tool.execute("call-1", { date: "May 15 2026" }),
		).rejects.toThrow(/Expected YYYY-MM-DD/);
	});

	it("rejects an invalid calendar date", async () => {
		const { app } = createMockApp();
		const tool = getDailyNoteTool(app);
		await expect(
			tool.execute("call-1", { date: "2026-02-30" }),
		).rejects.toThrow(/Invalid calendar date/);
	});

	it("trims trailing slash from folder", async () => {
		const { app, vault, setDailyNotesConfig } = createMockApp();
		setDailyNotesConfig({
			enabled: true,
			folder: "journal/",
			format: "YYYY-MM-DD",
		});
		vault.addFile("journal/2026-05-15.md", "");
		const tool = getDailyNoteTool(app);
		const result = await tool.execute("call-1", { date: "2026-05-15" });
		expect((result.details as GetDailyNoteDetails).path).toBe(
			"journal/2026-05-15.md",
		);
	});

	it("supports moment-like format tokens including escapes", async () => {
		const { app, setDailyNotesConfig } = createMockApp();
		setDailyNotesConfig({
			enabled: true,
			folder: "",
			format: "[Daily] YYYY-MM-DD ddd",
		});
		const tool = getDailyNoteTool(app);
		const result = await tool.execute("call-1", { date: "2026-05-15" });
		// 2026-05-15 is a Friday.
		expect((result.details as GetDailyNoteDetails).path).toBe(
			"Daily 2026-05-15 Fri.md",
		);
	});
});

describe("get_headings", () => {
	it("returns the heading outline with levels and lines", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		vault.setHeadings("note.md", [
			{ heading: "Intro", level: 1, line: 0 },
			{ heading: "Section A", level: 2, line: 5 },
			{ heading: "Detail", level: 3, line: 10 },
		]);
		const tool = getHeadingsTool(app);
		const result = await tool.execute("call-1", { path: "note.md" });
		const details = result.details as GetHeadingsDetails;
		expect(details.count).toBe(3);
		expect(details.headings).toEqual([
			{ text: "Intro", level: 1, line: 0 },
			{ text: "Section A", level: 2, line: 5 },
			{ text: "Detail", level: 3, line: 10 },
		]);
	});

	it("indents nested headings in the rendered outline", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "");
		vault.setHeadings("note.md", [
			{ heading: "Top", level: 1, line: 0 },
			{ heading: "Nested", level: 3, line: 2 },
		]);
		const tool = getHeadingsTool(app);
		const result = await tool.execute("call-1", { path: "note.md" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("- Top (line 1, h1)");
		expect(text).toContain("    - Nested (line 3, h3)");
	});

	it("returns an empty outline message when there are no headings", async () => {
		const { app, vault } = createMockApp();
		vault.addFile("note.md", "no headings here");
		const tool = getHeadingsTool(app);
		const result = await tool.execute("call-1", { path: "note.md" });
		expect((result.details as GetHeadingsDetails).count).toBe(0);
		expect((result.content[0] as { text: string }).text).toMatch(
			/no headings/,
		);
	});

	it("throws on missing path", async () => {
		const { app } = createMockApp();
		const tool = getHeadingsTool(app);
		await expect(tool.execute("call-1", { path: "ghost.md" })).rejects.toThrow(
			/No file at vault path/,
		);
	});

	it("throws when path is a folder", async () => {
		const { app, vault } = createMockApp();
		vault.addFolder("projects");
		const tool = getHeadingsTool(app);
		await expect(
			tool.execute("call-1", { path: "projects" }),
		).rejects.toThrow(/folder, not a file/);
	});
});
