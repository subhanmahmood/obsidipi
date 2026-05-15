import type { App, TFile } from "obsidian";

export interface NoteCandidate {
	path: string;
	basename: string;
	mtime: number;
	aliases: string[];
}

export interface ScoredCandidate {
	candidate: NoteCandidate;
	score: number;
	matchedKey: string;
	matchedText: string;
}

export type FuzzyFn = (text: string) => { score: number } | null;
export type FuzzyFactory = (query: string) => FuzzyFn;

const MAX_RESULTS = 8;

export function collectCandidates(app: App): NoteCandidate[] {
	const files = app.vault.getMarkdownFiles();
	const out: NoteCandidate[] = [];
	for (const file of files) {
		out.push({
			path: file.path,
			basename: file.basename,
			mtime: file.stat?.mtime ?? 0,
			aliases: readAliases(app, file),
		});
	}
	return out;
}

function readAliases(app: App, file: TFile): string[] {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return [];
	const raw = (fm as Record<string, unknown>).aliases ?? (fm as Record<string, unknown>).alias;
	if (Array.isArray(raw)) {
		return raw.filter((a): a is string => typeof a === "string" && a.length > 0);
	}
	if (typeof raw === "string" && raw.length > 0) return [raw];
	return [];
}

/**
 * Rank candidates against a query. Pure function — caller supplies the fuzzy
 * factory so tests can stub Obsidian's prepareFuzzySearch.
 *
 * Empty query: return the most-recently-modified candidates so the picker
 * surfaces useful starting suggestions on a bare `@`.
 */
export function rankCandidates(
	query: string,
	candidates: NoteCandidate[],
	makeFuzzy: FuzzyFactory,
	limit = MAX_RESULTS,
): ScoredCandidate[] {
	if (query.length === 0) {
		return [...candidates]
			.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
			.slice(0, limit)
			.map((c) => ({
				candidate: c,
				score: 0,
				matchedKey: "basename",
				matchedText: c.basename,
			}));
	}
	const fuzzy = makeFuzzy(query);
	const scored: ScoredCandidate[] = [];
	for (const c of candidates) {
		const best = bestMatch(c, fuzzy);
		if (best) scored.push(best);
	}
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			a.candidate.basename.length - b.candidate.basename.length ||
			a.candidate.path.localeCompare(b.candidate.path),
	);
	return scored.slice(0, limit);
}

function bestMatch(
	candidate: NoteCandidate,
	fuzzy: FuzzyFn,
): ScoredCandidate | null {
	const keys: Array<{ key: string; text: string; bonus: number }> = [
		{ key: "basename", text: candidate.basename, bonus: 0.1 },
		{ key: "path", text: candidate.path, bonus: 0 },
	];
	for (const alias of candidate.aliases) {
		keys.push({ key: "alias", text: alias, bonus: 0.05 });
	}
	let best: ScoredCandidate | null = null;
	for (const k of keys) {
		const res = fuzzy(k.text);
		if (!res) continue;
		const score = res.score + k.bonus;
		if (!best || score > best.score) {
			best = {
				candidate,
				score,
				matchedKey: k.key,
				matchedText: k.text,
			};
		}
	}
	return best;
}

export interface MentionTrigger {
	start: number;
	query: string;
}

/**
 * Detect an active `@` mention at the cursor. The `@` must be at the start of
 * the input OR follow whitespace, so emails / inline `@foo` outside mention
 * context don't false-trigger. The query must not contain whitespace or
 * `]` / `[` (those terminate the mention).
 */
export function detectMentionTrigger(
	value: string,
	cursor: number,
): MentionTrigger | null {
	if (cursor <= 0 || cursor > value.length) return null;
	for (let i = cursor - 1; i >= 0; i--) {
		const ch = value[i];
		if (ch === "@") {
			if (i > 0) {
				const prev = value[i - 1] ?? "";
				if (!/\s/.test(prev)) return null;
			}
			const query = value.slice(i + 1, cursor);
			if (/[\s\[\]\n]/.test(query)) return null;
			return { start: i, query };
		}
		if (ch === undefined) return null;
		if (/[\s\n]/.test(ch)) return null;
		if (ch === "[" || ch === "]") return null;
	}
	return null;
}

export function buildMentionInsertion(path: string): string {
	return `[[${path}]] `;
}
