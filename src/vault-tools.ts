import { Type, type Static } from "typebox";
import type { App, TFile } from "obsidian";
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
