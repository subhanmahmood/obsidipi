import { Type, type Static } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
	id: string;
	text: string;
	status: TodoStatus;
}

export interface PlanRequest {
	toolCallId: string;
	steps: string[];
	resolve: (response: { approved: boolean; note?: string }) => void;
}

export interface AskUserRequest {
	toolCallId: string;
	question: string;
	options: string[];
	resolve: (response: { answer: string; chip: boolean }) => void;
}

export interface MetaUxBridge {
	showPlan: (req: PlanRequest, signal?: AbortSignal) => void;
	askUser: (req: AskUserRequest, signal?: AbortSignal) => void;
	setTodos: (items: TodoItem[]) => void;
	checkTodo: (id: string) => { ok: boolean; item?: TodoItem };
}

const PlanParams = Type.Object({
	steps: Type.Array(
		Type.String({
			description:
				"A single, concrete step in the plan. Keep each step to one short sentence.",
		}),
		{
			description:
				"Ordered list of steps the agent will take. The agent pauses until the user approves the plan.",
			minItems: 1,
		},
	),
});

export interface PlanDetails {
	steps: string[];
	approved: boolean;
	note?: string;
}

export function planTool(
	bridge: MetaUxBridge,
): AgentTool<typeof PlanParams, PlanDetails> {
	return {
		name: "plan",
		label: "Propose a plan",
		description:
			"Propose a plan to the user as an ordered list of steps. Execution pauses until " +
			"the user approves with 'Go' or rejects. Use this before any multi-step work " +
			"(roughly: more than three tool calls or any mutating action followed by reads). " +
			"After approval, follow the plan; do not loop back to call plan again unless the " +
			"scope materially changes.",
		parameters: PlanParams,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal) => {
			const response = await waitForPlanDecision(
				bridge,
				{ toolCallId, steps: params.steps },
				signal,
			);
			const text = response.approved
				? response.note
					? `Plan approved. User note: ${response.note}. Proceed.`
					: "Plan approved. Proceed."
				: response.note
					? `Plan rejected by user: ${response.note}. Wait for further direction; do not retry the same plan.`
					: "Plan rejected by user. Wait for further direction; do not retry the same plan.";
			return {
				content: [{ type: "text", text }],
				details: {
					steps: params.steps,
					approved: response.approved,
					note: response.note,
				},
			};
		},
	};
}

function waitForPlanDecision(
	bridge: MetaUxBridge,
	base: { toolCallId: string; steps: string[] },
	signal?: AbortSignal,
): Promise<{ approved: boolean; note?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: { approved: boolean; note?: string }) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => settle({ approved: false, note: "run aborted" });
		if (signal?.aborted) {
			settle({ approved: false, note: "run aborted" });
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		bridge.showPlan(
			{ toolCallId: base.toolCallId, steps: base.steps, resolve: settle },
			signal,
		);
	});
}

const AskUserParams = Type.Object({
	question: Type.String({
		description:
			"Short, specific question for the user. Should be answerable in one phrase or chip-pick.",
	}),
	options: Type.Optional(
		Type.Array(
			Type.String({ description: "A pre-canned reply option." }),
			{
				description:
					"Optional quick-reply choices. The user can tap one or type a free-text reply. " +
					"Keep to 2–4 short options.",
				maxItems: 6,
			},
		),
	),
});

export interface AskUserDetails {
	question: string;
	options: string[];
	answer: string;
	chip: boolean;
}

export function askUserTool(
	bridge: MetaUxBridge,
): AgentTool<typeof AskUserParams, AskUserDetails> {
	return {
		name: "ask_user",
		label: "Ask the user",
		description:
			"Pause to ask the user a clarifying question. Pass `options` for quick-reply chips. " +
			"Use only when proceeding without an answer would risk wrong work — don't pepper the " +
			"user with unnecessary questions.",
		parameters: AskUserParams,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal) => {
			const options = params.options ?? [];
			const response = await waitForAnswer(
				bridge,
				{ toolCallId, question: params.question, options },
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text: `User answered: ${response.answer}`,
					},
				],
				details: {
					question: params.question,
					options,
					answer: response.answer,
					chip: response.chip,
				},
			};
		},
	};
}

function waitForAnswer(
	bridge: MetaUxBridge,
	base: { toolCallId: string; question: string; options: string[] },
	signal?: AbortSignal,
): Promise<{ answer: string; chip: boolean }> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: { answer: string; chip: boolean }) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => settle({ answer: "(run aborted)", chip: false });
		if (signal?.aborted) {
			settle({ answer: "(run aborted)", chip: false });
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		bridge.askUser(
			{
				toolCallId: base.toolCallId,
				question: base.question,
				options: base.options,
				resolve: settle,
			},
			signal,
		);
	});
}

const TodoStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("done"),
]);

const TodoItemSchema = Type.Object({
	id: Type.String({
		description:
			"Stable identifier for the item (e.g. '1', 'parse-frontmatter'). Reused across " +
			"todo_write calls so todo_check can target this item.",
	}),
	text: Type.String({
		description: "Short description of the item, in user-visible language.",
	}),
	status: Type.Optional(TodoStatusSchema),
});

const TodoWriteParams = Type.Object({
	items: Type.Array(TodoItemSchema, {
		description:
			"The full list. Replaces any previous list. Order is preserved in the UI.",
	}),
});

export interface TodoWriteDetails {
	count: number;
	items: TodoItem[];
}

export function todoWriteTool(
	bridge: MetaUxBridge,
): AgentTool<typeof TodoWriteParams, TodoWriteDetails> {
	return {
		name: "todo_write",
		label: "Set todo list",
		description:
			"Replace the visible todo list with a new set of items. Each item needs a stable " +
			"`id` and a short `text`; status defaults to 'pending'. Call this up front to " +
			"surface the work you intend to do, and again when items move to 'in_progress'. " +
			"Use todo_check to tick items off as 'done'.",
		parameters: TodoWriteParams,
		executionMode: "sequential",
		execute: async (_toolCallId, params: Static<typeof TodoWriteParams>) => {
			const seen = new Set<string>();
			const items: TodoItem[] = params.items.map((raw) => {
				const id = raw.id.trim();
				const text = raw.text.trim();
				if (id.length === 0) throw new Error("Todo `id` must be non-empty.");
				if (text.length === 0)
					throw new Error("Todo `text` must be non-empty.");
				if (seen.has(id)) throw new Error(`Duplicate todo id: ${id}`);
				seen.add(id);
				return {
					id,
					text,
					status: raw.status ?? "pending",
				};
			});
			bridge.setTodos(items);
			return {
				content: [
					{
						type: "text",
						text: renderTodoSummary(items),
					},
				],
				details: { count: items.length, items },
			};
		},
	};
}

function renderTodoSummary(items: TodoItem[]): string {
	if (items.length === 0) return "Todo list cleared.";
	const done = items.filter((i) => i.status === "done").length;
	const lines = items.map((i) => `${statusGlyph(i.status)} ${i.text}`);
	return `Todo list (${done}/${items.length} done):\n${lines.join("\n")}`;
}

function statusGlyph(status: TodoStatus): string {
	if (status === "done") return "[x]";
	if (status === "in_progress") return "[~]";
	return "[ ]";
}

const TodoCheckParams = Type.Object({
	id: Type.String({
		description: "ID of the todo to mark as done.",
	}),
});

export interface TodoCheckDetails {
	id: string;
	text: string;
	status: TodoStatus;
}

export function todoCheckTool(
	bridge: MetaUxBridge,
): AgentTool<typeof TodoCheckParams, TodoCheckDetails> {
	return {
		name: "todo_check",
		label: "Mark todo done",
		description:
			"Mark the todo item with the given `id` as done. Fails if no item with that id exists. " +
			"Tick items off as you complete them so the user can see progress.",
		parameters: TodoCheckParams,
		executionMode: "sequential",
		execute: async (_toolCallId, params: Static<typeof TodoCheckParams>) => {
			const id = params.id.trim();
			if (id.length === 0) {
				throw new Error("`id` must be a non-empty string.");
			}
			const result = bridge.checkTodo(id);
			if (!result.ok || !result.item) {
				throw new Error(`No todo with id: ${id}`);
			}
			return {
				content: [
					{
						type: "text",
						text: `Marked '${result.item.text}' as done.`,
					},
				],
				details: {
					id: result.item.id,
					text: result.item.text,
					status: result.item.status,
				},
			};
		},
	};
}
