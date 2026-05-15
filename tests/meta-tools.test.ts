import { describe, expect, it } from "vitest";
import {
	askUserTool,
	type MetaUxBridge,
	planTool,
	type TodoItem,
	todoCheckTool,
	todoWriteTool,
} from "../src/meta-tools";

interface PlanCapture {
	steps: string[];
	resolve: (response: { approved: boolean; note?: string }) => void;
}

interface AskCapture {
	question: string;
	options: string[];
	resolve: (response: { answer: string; chip: boolean }) => void;
}

interface BridgeHandle {
	bridge: MetaUxBridge;
	todos: TodoItem[];
	planRequests: PlanCapture[];
	askRequests: AskCapture[];
}

function makeBridge(): BridgeHandle {
	const handle: BridgeHandle = {
		todos: [],
		planRequests: [],
		askRequests: [],
		bridge: undefined as unknown as MetaUxBridge,
	};
	handle.bridge = {
		showPlan: (req) => {
			handle.planRequests.push({
				steps: req.steps,
				resolve: req.resolve,
			});
		},
		askUser: (req) => {
			handle.askRequests.push({
				question: req.question,
				options: req.options,
				resolve: req.resolve,
			});
		},
		setTodos: (items) => {
			handle.todos = items.map((i) => ({ ...i }));
		},
		checkTodo: (id) => {
			const idx = handle.todos.findIndex((i) => i.id === id);
			if (idx === -1) return { ok: false };
			handle.todos[idx] = { ...handle.todos[idx], status: "done" };
			return { ok: true, item: handle.todos[idx] };
		},
	};
	return handle;
}

describe("plan", () => {
	it("waits for user approval and reports approved=true with note", async () => {
		const handle = makeBridge();
		const tool = planTool(handle.bridge);
		const exec = tool.execute("call-1", { steps: ["step one", "step two"] });
		// Wait a microtask so showPlan has been called.
		await Promise.resolve();
		expect(handle.planRequests).toHaveLength(1);
		handle.planRequests[0].resolve({ approved: true, note: "lgtm" });
		const result = await exec;
		expect(result.details).toEqual({
			steps: ["step one", "step two"],
			approved: true,
			note: "lgtm",
		});
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toMatch(/approved/i);
		expect((result.content[0] as { text: string }).text).toMatch(/lgtm/);
	});

	it("reports rejection with a note", async () => {
		const handle = makeBridge();
		const tool = planTool(handle.bridge);
		const exec = tool.execute("call-1", { steps: ["only step"] });
		await Promise.resolve();
		handle.planRequests[0].resolve({ approved: false, note: "do X instead" });
		const result = await exec;
		expect(result.details.approved).toBe(false);
		expect(result.details.note).toBe("do X instead");
		expect((result.content[0] as { text: string }).text).toMatch(/rejected/i);
		expect((result.content[0] as { text: string }).text).toMatch(/do X instead/);
	});

	it("settles as rejected when the abort signal fires", async () => {
		const handle = makeBridge();
		const tool = planTool(handle.bridge);
		const controller = new AbortController();
		const exec = tool.execute(
			"call-1",
			{ steps: ["step"] },
			controller.signal,
		);
		await Promise.resolve();
		controller.abort();
		const result = await exec;
		expect(result.details.approved).toBe(false);
		expect(result.details.note).toBe("run aborted");
	});
});

describe("ask_user", () => {
	it("forwards the user's chip answer", async () => {
		const handle = makeBridge();
		const tool = askUserTool(handle.bridge);
		const exec = tool.execute("call-1", {
			question: "Inbox folder?",
			options: ["inbox", "notes/inbox"],
		});
		await Promise.resolve();
		expect(handle.askRequests[0].question).toBe("Inbox folder?");
		expect(handle.askRequests[0].options).toEqual(["inbox", "notes/inbox"]);
		handle.askRequests[0].resolve({ answer: "inbox", chip: true });
		const result = await exec;
		expect(result.details).toEqual({
			question: "Inbox folder?",
			options: ["inbox", "notes/inbox"],
			answer: "inbox",
			chip: true,
		});
		expect((result.content[0] as { text: string }).text).toBe(
			"User answered: inbox",
		);
	});

	it("forwards free-text answers when no chip was picked", async () => {
		const handle = makeBridge();
		const tool = askUserTool(handle.bridge);
		const exec = tool.execute("call-1", { question: "Folder?" });
		await Promise.resolve();
		expect(handle.askRequests[0].options).toEqual([]);
		handle.askRequests[0].resolve({ answer: "drafts/2026", chip: false });
		const result = await exec;
		expect(result.details.chip).toBe(false);
		expect(result.details.options).toEqual([]);
		expect(result.details.answer).toBe("drafts/2026");
	});

	it("returns aborted sentinel when the signal fires", async () => {
		const handle = makeBridge();
		const tool = askUserTool(handle.bridge);
		const controller = new AbortController();
		const exec = tool.execute("call-1", { question: "?" }, controller.signal);
		await Promise.resolve();
		controller.abort();
		const result = await exec;
		expect(result.details.answer).toBe("(run aborted)");
		expect(result.details.chip).toBe(false);
	});
});

describe("todo_write", () => {
	it("pushes items into the bridge with default pending status", async () => {
		const handle = makeBridge();
		const tool = todoWriteTool(handle.bridge);
		const result = await tool.execute("call-1", {
			items: [
				{ id: "1", text: "draft" },
				{ id: "2", text: "review", status: "in_progress" },
			],
		});
		expect(handle.todos).toEqual([
			{ id: "1", text: "draft", status: "pending" },
			{ id: "2", text: "review", status: "in_progress" },
		]);
		expect(result.details.count).toBe(2);
		expect((result.content[0] as { text: string }).text).toMatch(/0\/2/);
	});

	it("rejects duplicate ids", async () => {
		const handle = makeBridge();
		const tool = todoWriteTool(handle.bridge);
		await expect(
			tool.execute("call-1", {
				items: [
					{ id: "x", text: "a" },
					{ id: "x", text: "b" },
				],
			}),
		).rejects.toThrow(/duplicate/i);
	});

	it("rejects empty id or text", async () => {
		const handle = makeBridge();
		const tool = todoWriteTool(handle.bridge);
		await expect(
			tool.execute("call-1", { items: [{ id: "  ", text: "a" }] }),
		).rejects.toThrow(/id/);
		await expect(
			tool.execute("call-1", { items: [{ id: "x", text: "" }] }),
		).rejects.toThrow(/text/);
	});

	it("trims whitespace on id and text", async () => {
		const handle = makeBridge();
		const tool = todoWriteTool(handle.bridge);
		await tool.execute("call-1", {
			items: [{ id: " a ", text: "  hello  " }],
		});
		expect(handle.todos).toEqual([{ id: "a", text: "hello", status: "pending" }]);
	});
});

describe("todo_check", () => {
	it("marks an existing item as done", async () => {
		const handle = makeBridge();
		const writer = todoWriteTool(handle.bridge);
		const checker = todoCheckTool(handle.bridge);
		await writer.execute("call-1", {
			items: [
				{ id: "1", text: "draft" },
				{ id: "2", text: "review" },
			],
		});
		const result = await checker.execute("call-2", { id: "1" });
		expect(handle.todos[0].status).toBe("done");
		expect(handle.todos[1].status).toBe("pending");
		expect(result.details).toEqual({ id: "1", text: "draft", status: "done" });
	});

	it("rejects unknown id", async () => {
		const handle = makeBridge();
		const checker = todoCheckTool(handle.bridge);
		await expect(checker.execute("call-1", { id: "nope" })).rejects.toThrow(
			/No todo with id: nope/,
		);
	});

	it("rejects empty id", async () => {
		const handle = makeBridge();
		const checker = todoCheckTool(handle.bridge);
		await expect(checker.execute("call-1", { id: "   " })).rejects.toThrow(
			/non-empty/,
		);
	});
});
