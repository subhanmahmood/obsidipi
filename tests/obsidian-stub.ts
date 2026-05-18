// Runtime stub for the `obsidian` module — the published package only ships
// typings (its `main` is empty), so any code that does a runtime import like
// `import { requestUrl } from "obsidian"` would fail to resolve in vitest.
// Aliased in vitest.config.ts. Tests can vi.mock("obsidian", ...) to override
// the exports they care about.
export const requestUrl = async () => {
	throw new Error("obsidian stub: requestUrl was called without vi.mock");
};

export class MarkdownRenderer {
	static async render() {
		throw new Error("obsidian stub: MarkdownRenderer.render was called");
	}
}

export class ItemView {}
export class WorkspaceLeaf {}
export class Notice {
	constructor(_message: string, _timeout?: number) {}
}
export const setIcon = () => undefined;
export const prepareFuzzySearch = () => () => null;
export class FuzzySuggestModal<T> {
	constructor(..._args: unknown[]) {}
	setPlaceholder(_p: string) {}
	open() {}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
	onChooseItem(_item: T): void {}
}
