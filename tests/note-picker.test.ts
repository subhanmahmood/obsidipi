import { describe, expect, it } from "vitest";
import {
	buildMentionInsertion,
	detectMentionTrigger,
	rankCandidates,
	type FuzzyFactory,
	type NoteCandidate,
} from "../src/note-picker";

// Stub fuzzy: every contiguous-subsequence match scores by character coverage.
// Lower-cases both sides. Returns null on miss. Tests don't care about exact
// scoring semantics — they just need a deterministic ordering signal.
const stubFuzzy: FuzzyFactory = (query) => {
	const q = query.toLowerCase();
	return (text) => {
		const t = text.toLowerCase();
		if (q.length === 0) return { score: 0 };
		let ti = 0;
		let matched = 0;
		for (const ch of q) {
			const idx = t.indexOf(ch, ti);
			if (idx === -1) return null;
			matched++;
			ti = idx + 1;
		}
		// Reward shorter targets (more characters of `t` matched).
		const ratio = matched / t.length;
		return { score: ratio };
	};
};

function candidate(
	path: string,
	mtime = 0,
	aliases: string[] = [],
): NoteCandidate {
	const slash = path.lastIndexOf("/");
	const file = slash === -1 ? path : path.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	const basename = dot === -1 ? file : file.slice(0, dot);
	return { path, basename, mtime, aliases };
}

describe("detectMentionTrigger", () => {
	it("detects @ at start of input", () => {
		const t = detectMentionTrigger("@foo", 4);
		expect(t).toEqual({ start: 0, query: "foo" });
	});

	it("detects @ after a space", () => {
		const t = detectMentionTrigger("hello @foo", 10);
		expect(t).toEqual({ start: 6, query: "foo" });
	});

	it("returns null when @ follows a non-space character (email-like)", () => {
		expect(detectMentionTrigger("name@foo", 8)).toBeNull();
	});

	it("returns null when @ isn't found before whitespace", () => {
		expect(detectMentionTrigger("hello world", 11)).toBeNull();
	});

	it("returns null when there's whitespace between @ and cursor", () => {
		expect(detectMentionTrigger("@foo bar", 8)).toBeNull();
	});

	it("returns null when [ or ] are between @ and cursor", () => {
		expect(detectMentionTrigger("@foo[", 5)).toBeNull();
		expect(detectMentionTrigger("@fo]", 4)).toBeNull();
	});

	it("returns an empty query for a bare @", () => {
		const t = detectMentionTrigger("@", 1);
		expect(t).toEqual({ start: 0, query: "" });
	});

	it("respects cursor position when typing further", () => {
		const t = detectMentionTrigger("@foo extra", 4);
		expect(t).toEqual({ start: 0, query: "foo" });
	});

	it("returns null past a newline", () => {
		expect(detectMentionTrigger("@foo\nbar", 8)).toBeNull();
	});

	it("returns null when cursor is at 0", () => {
		expect(detectMentionTrigger("@foo", 0)).toBeNull();
	});
});

describe("rankCandidates", () => {
	it("returns most-recently-modified candidates on empty query", () => {
		const out = rankCandidates(
			"",
			[
				candidate("old.md", 1),
				candidate("new.md", 100),
				candidate("middle.md", 50),
			],
			stubFuzzy,
		);
		expect(out.map((r) => r.candidate.path)).toEqual([
			"new.md",
			"middle.md",
			"old.md",
		]);
	});

	it("ranks by fuzzy score on a query", () => {
		const out = rankCandidates(
			"abc",
			[
				candidate("abcdefghij.md"), // shorter ratio: low
				candidate("abc.md"), // exact-ish: highest
				candidate("aaabbbccc.md"),
				candidate("xyz.md"), // miss
			],
			stubFuzzy,
		);
		expect(out[0]?.candidate.path).toBe("abc.md");
		expect(out.map((r) => r.candidate.path)).not.toContain("xyz.md");
	});

	it("prefers a basename match over a deep-path match", () => {
		const out = rankCandidates(
			"hello",
			[
				candidate("projects/2024/q3/hello-world-very-long-path.md"),
				candidate("hello.md"),
			],
			stubFuzzy,
		);
		expect(out[0]?.candidate.path).toBe("hello.md");
	});

	it("matches aliases as well as basename/path", () => {
		const out = rankCandidates(
			"daily",
			[candidate("2026-05-15.md", 0, ["Daily log"])],
			stubFuzzy,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.matchedKey).toBe("alias");
	});

	it("limits to the top N", () => {
		const cs: NoteCandidate[] = [];
		for (let i = 0; i < 20; i++) cs.push(candidate(`note${i}.md`));
		const out = rankCandidates("note", cs, stubFuzzy, 5);
		expect(out).toHaveLength(5);
	});

	it("drops candidates with no match on any key", () => {
		const out = rankCandidates(
			"zzz",
			[candidate("abc.md"), candidate("zzz-match.md")],
			stubFuzzy,
		);
		expect(out.map((r) => r.candidate.path)).toEqual(["zzz-match.md"]);
	});

	it("falls back to recency when no candidates match (empty result)", () => {
		// Sanity: a query that matches nothing returns []
		const out = rankCandidates(
			"impossible",
			[candidate("a.md"), candidate("b.md")],
			stubFuzzy,
		);
		expect(out).toEqual([]);
	});
});

describe("buildMentionInsertion", () => {
	it("wraps the path in wiki-link brackets with a trailing space", () => {
		expect(buildMentionInsertion("inbox.md")).toBe("[[inbox.md]] ");
	});

	it("preserves nested paths", () => {
		expect(buildMentionInsertion("projects/alpha.md")).toBe(
			"[[projects/alpha.md]] ",
		);
	});
});
