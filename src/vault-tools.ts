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

function isTFile(file: object): file is TFile {
	return "stat" in file && "extension" in file;
}
