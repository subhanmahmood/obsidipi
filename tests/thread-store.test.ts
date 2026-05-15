import { describe, expect, it } from "vitest";
import type { Message } from "@mariozechner/pi-ai";
import {
	defaultThreadPath,
	defaultTitleFromMessage,
	deleteThread,
	generateThreadId,
	loadThread,
	makeNewThread,
	parseFrontmatter,
	parseStateBlock,
	renderThreadFile,
	saveThread,
	slugifyTitle,
	THREADS_FOLDER,
	listThreads,
} from "../src/thread-store";
import { createMockApp } from "./mock-obsidian";

const baseAssistantFields = {
	api: "openai-completions" as const,
	provider: "deepseek",
	model: "deepseek-chat",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 1_700_000_000_000,
};

const sampleMessages: Message[] = [
	{ role: "user", content: "summarise @inbox", timestamp: 1_700_000_000_000 },
	{
		role: "assistant",
		...baseAssistantFields,
		content: [
			{ type: "text", text: "Here you go." },
			{
				type: "toolCall",
				id: "call-1",
				name: "read_note",
				arguments: { path: "inbox.md" },
			},
		],
	},
	{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read_note",
		isError: false,
		content: [{ type: "text", text: "inbox contents" }],
		details: { path: "inbox.md", bytes: 14 },
		timestamp: 1_700_000_001_000,
	},
];

describe("slugifyTitle", () => {
	it("lowercases, strips punctuation, and dasherizes", () => {
		expect(slugifyTitle("Summarise inbox.md please!")).toBe(
			"summarise-inbox-md-please",
		);
	});

	it("strips wiki-link syntax from the slug", () => {
		expect(slugifyTitle("ask about [[house/shed base.md]]")).toBe(
			"ask-about-house-shed-base-md",
		);
	});

	it("caps length", () => {
		const long = "x".repeat(200);
		expect(slugifyTitle(long).length).toBeLessThanOrEqual(48);
	});

	it("falls back to 'thread' when input has no usable chars", () => {
		expect(slugifyTitle("!!!")).toBe("thread");
	});
});

describe("defaultTitleFromMessage", () => {
	it("strips wiki-link brackets but keeps the readable text", () => {
		expect(defaultTitleFromMessage("@[[inbox.md]] summarise")).toBe(
			"inbox.md summarise",
		);
	});

	it("collapses whitespace and trims", () => {
		expect(defaultTitleFromMessage("  hello\n\nworld  ")).toBe("hello world");
	});

	it("truncates overlong titles with an ellipsis", () => {
		const long = "x".repeat(200);
		const out = defaultTitleFromMessage(long);
		expect(out.length).toBe(78);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("defaultThreadPath", () => {
	it("uses the date + slug + last-6-of-id under the threads folder", () => {
		const path = defaultThreadPath(
			"2026-05-15T20:00:00Z",
			"Summarise inbox",
			"abcdef1234567890",
		);
		expect(path).toBe(`${THREADS_FOLDER}/2026-05-15-summarise-inbox-567890.md`);
	});
});

describe("renderThreadFile + parseStateBlock round-trip", () => {
	it("serializes and re-parses the messages array", () => {
		const thread = {
			id: "thread-abc",
			title: "Summarise inbox",
			provider: "deepseek",
			model: "deepseek-chat",
			createdAt: "2026-05-15T20:00:00Z",
			updatedAt: "2026-05-15T20:14:33Z",
			messages: sampleMessages,
		};
		const file = renderThreadFile(thread);
		expect(file).toContain("obsidipi: thread");
		expect(file).toContain("## user");
		expect(file).toContain("## assistant");
		expect(file).toContain("### tool call · read_note");
		expect(file).toContain("## tool · read_note");
		expect(file).toContain("%%obsidipi-state");

		const messages = parseStateBlock(file);
		expect(messages).toEqual(sampleMessages);
	});

	it("quotes frontmatter values containing spaces", () => {
		const thread = {
			id: "thread-abc",
			title: "Has spaces and: punctuation",
			provider: "deepseek",
			model: "deepseek-chat",
			createdAt: "2026-05-15T20:00:00Z",
			updatedAt: "2026-05-15T20:00:00Z",
			messages: [],
		};
		const file = renderThreadFile(thread);
		const fm = parseFrontmatter(file);
		expect(fm.title).toBe("Has spaces and: punctuation");
	});

	it("throws when the state block is missing", () => {
		expect(() => parseStateBlock("just a regular note")).toThrow(
			/missing the obsidipi-state/,
		);
	});

	it("throws on malformed JSON inside the state block", () => {
		const bad =
			"%%obsidipi-state\n```json\n{not json}\n```\n%%";
		expect(() => parseStateBlock(bad)).toThrow(/not valid JSON/);
	});

	it("rejects a state block without a messages array", () => {
		const bad =
			'%%obsidipi-state\n```json\n{"version":1}\n```\n%%';
		expect(() => parseStateBlock(bad)).toThrow(/messages.*array/);
	});
});

describe("saveThread + loadThread", () => {
	it("creates the threads folder and writes the file on first save", async () => {
		const { app, vault } = createMockApp();
		const thread = makeNewThread("deepseek", "deepseek-chat", "summarise @inbox");
		thread.messages = sampleMessages;
		const saved = await saveThread(app, thread);
		expect(saved.path).toBeTruthy();
		expect(vault.hasEntry(saved.path!)).toBe(true);
		expect(vault.hasEntry(THREADS_FOLDER)).toBe(true);
	});

	it("round-trips through the vault", async () => {
		const { app } = createMockApp();
		const thread = makeNewThread("deepseek", "deepseek-chat", "test thread");
		thread.messages = sampleMessages;
		const saved = await saveThread(app, thread);
		const loaded = await loadThread(app, saved.path!);
		expect(loaded.id).toBe(thread.id);
		expect(loaded.title).toBe(thread.title);
		expect(loaded.provider).toBe("deepseek");
		expect(loaded.model).toBe("deepseek-chat");
		expect(loaded.messages).toEqual(sampleMessages);
	});

	it("overwrites the same file on subsequent saves", async () => {
		const { app } = createMockApp();
		const thread = makeNewThread("deepseek", "deepseek-chat", "test");
		const firstSave = await saveThread(app, thread);
		const updated = {
			...firstSave,
			messages: [
				...sampleMessages,
				{
					role: "user" as const,
					content: "more",
					timestamp: 1_700_000_002_000,
				},
			],
		};
		const secondSave = await saveThread(app, updated);
		expect(secondSave.path).toBe(firstSave.path);
		const loaded = await loadThread(app, secondSave.path!);
		expect(loaded.messages).toHaveLength(4);
	});

	it("updates `updatedAt` on each save", async () => {
		const { app } = createMockApp();
		const thread = makeNewThread("deepseek", "deepseek-chat", "test");
		const first = await saveThread(app, thread);
		await new Promise((r) => setTimeout(r, 5));
		const second = await saveThread(app, first);
		expect(second.updatedAt >= first.updatedAt).toBe(true);
	});
});

describe("listThreads", () => {
	it("returns empty array when the threads folder does not exist", async () => {
		const { app } = createMockApp();
		const out = await listThreads(app);
		expect(out).toEqual([]);
	});

	it("lists saved threads sorted by updatedAt descending", async () => {
		const { app } = createMockApp();
		const t1 = makeNewThread("deepseek", "deepseek-chat", "first");
		await saveThread(app, t1);
		await new Promise((r) => setTimeout(r, 5));
		const t2 = makeNewThread("deepseek", "deepseek-chat", "second");
		await saveThread(app, t2);
		const out = await listThreads(app);
		expect(out).toHaveLength(2);
		expect(out[0]?.title).toBe("second");
		expect(out[1]?.title).toBe("first");
	});

	it("skips non-obsidipi files in the threads folder", async () => {
		const { app, vault } = createMockApp();
		const t = makeNewThread("deepseek", "deepseek-chat", "real");
		await saveThread(app, t);
		vault.addFile(`${THREADS_FOLDER}/random.md`, "just a note");
		const out = await listThreads(app);
		expect(out).toHaveLength(1);
		expect(out[0]?.title).toBe("real");
	});

	it("falls back to the adapter when the threads folder is hidden from the metadata cache", async () => {
		// Simulates Obsidian's metadata cache ignoring dot-prefixed folders on iOS:
		// getAbstractFileByPath('.harness/...') returns null even though the file
		// exists on disk. listThreads should still find them via adapter.list.
		const { app, hideFromMetadataCache } = createMockApp();
		const t = makeNewThread("deepseek", "deepseek-chat", "hidden");
		await saveThread(app, t);
		hideFromMetadataCache(".harness");
		const out = await listThreads(app);
		expect(out).toHaveLength(1);
		expect(out[0]?.title).toBe("hidden");
	});
});

describe("deleteThread", () => {
	it("removes the file from the vault", async () => {
		const { app, vault } = createMockApp();
		const t = makeNewThread("deepseek", "deepseek-chat", "doomed");
		const saved = await saveThread(app, t);
		expect(vault.hasEntry(saved.path!)).toBe(true);
		await deleteThread(app, saved.path!);
		expect(vault.hasEntry(saved.path!)).toBe(false);
	});

	it("works when the file is hidden from the metadata cache", async () => {
		const { app, vault, hideFromMetadataCache } = createMockApp();
		const t = makeNewThread("deepseek", "deepseek-chat", "hidden-and-doomed");
		const saved = await saveThread(app, t);
		hideFromMetadataCache(".harness");
		await deleteThread(app, saved.path!);
		expect(vault.hasEntry(saved.path!)).toBe(false);
	});

	it("throws on missing path", async () => {
		const { app } = createMockApp();
		await expect(
			deleteThread(app, `${THREADS_FOLDER}/ghost.md`),
		).rejects.toThrow(/No thread at/);
	});
});

describe("generateThreadId", () => {
	it("returns a non-empty string and differs between calls", () => {
		const a = generateThreadId();
		const b = generateThreadId();
		expect(a.length).toBeGreaterThan(8);
		expect(a).not.toBe(b);
	});
});
