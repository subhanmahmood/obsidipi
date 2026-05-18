import { Type, type Static } from "typebox";
import { requestUrl, type App } from "obsidian";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export type WebSearchProvider = "tavily" | "brave";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	score?: number;
}

export interface WebSearchDetails {
	query: string;
	provider: WebSearchProvider;
	results: WebSearchResult[];
	answer?: string;
}

const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			"Search query. Phrase it as if asking a knowledgeable assistant — the providers handle natural language.",
	}),
	maxResults: Type.Optional(
		Type.Integer({
			description: "Maximum number of results. Default 5, max 10.",
			minimum: 1,
			maximum: 10,
		}),
	),
});

const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 10;

export type GetProvider = () => WebSearchProvider | "off";
export type GetApiKey = () => string | null;

export function webSearchTool(
	_app: App,
	getApiKey: GetApiKey,
	getProvider: GetProvider,
): AgentTool<typeof WebSearchParams, WebSearchDetails> {
	return {
		name: "web_search",
		label: "Web search",
		description:
			"Search the public web. Use when the user asks about recent events, " +
			"external facts, or anything not in the vault. Returns a short list of " +
			"results, each with title, URL, and snippet. Cite URLs in your reply.",
		parameters: WebSearchParams,
		executionMode: "parallel",
		execute: async (
			_toolCallId: string,
			params: Static<typeof WebSearchParams>,
		) => {
			const provider = getProvider();
			if (provider === "off") {
				throw new Error(
					"Web search is disabled. Ask the user to enable it in Obsidipi settings.",
				);
			}
			const key = getApiKey();
			if (!key) {
				throw new Error(
					`No API key configured for web search provider '${provider}'. Ask the user to add one in settings.`,
				);
			}
			const max = clampMaxResults(params.maxResults);
			const { results, answer } = await callProvider(
				provider,
				params.query,
				key,
				max,
			);
			const text = renderResults(params.query, provider, results, answer);
			return {
				content: [{ type: "text", text }],
				details: { query: params.query, provider, results, answer },
			};
		},
	};
}

function clampMaxResults(requested: number | undefined): number {
	if (typeof requested !== "number" || requested < 1) return DEFAULT_MAX_RESULTS;
	return Math.min(Math.floor(requested), HARD_MAX_RESULTS);
}

async function callProvider(
	provider: WebSearchProvider,
	query: string,
	apiKey: string,
	maxResults: number,
): Promise<{ results: WebSearchResult[]; answer?: string }> {
	if (provider === "tavily") return callTavily(query, apiKey, maxResults);
	if (provider === "brave") return callBrave(query, apiKey, maxResults);
	throw new Error(`Unknown web search provider: ${String(provider)}`);
}

interface TavilyResponse {
	answer?: unknown;
	results?: Array<{
		title?: unknown;
		url?: unknown;
		content?: unknown;
		score?: unknown;
	}>;
}

async function callTavily(
	query: string,
	apiKey: string,
	maxResults: number,
): Promise<{ results: WebSearchResult[]; answer?: string }> {
	const res = await requestUrl({
		url: "https://api.tavily.com/search",
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({
			api_key: apiKey,
			query,
			max_results: maxResults,
			include_answer: true,
			search_depth: "basic",
		}),
		throw: false,
	});
	if (res.status >= 400) {
		throw new Error(`Tavily ${res.status}: ${res.text.slice(0, 200)}`);
	}
	const body = res.json as TavilyResponse | undefined;
	const raw = Array.isArray(body?.results) ? body!.results! : [];
	const results: WebSearchResult[] = raw
		.map((r) => ({
			title: typeof r.title === "string" ? r.title : "",
			url: typeof r.url === "string" ? r.url : "",
			snippet: typeof r.content === "string" ? r.content : "",
			score: typeof r.score === "number" ? r.score : undefined,
		}))
		.filter((r) => r.url.length > 0);
	const answer = typeof body?.answer === "string" ? body.answer : undefined;
	return { results, answer };
}

interface BraveResponse {
	web?: {
		results?: Array<{
			title?: unknown;
			url?: unknown;
			description?: unknown;
		}>;
	};
}

async function callBrave(
	query: string,
	apiKey: string,
	maxResults: number,
): Promise<{ results: WebSearchResult[]; answer?: string }> {
	const url =
		"https://api.search.brave.com/res/v1/web/search?q=" +
		encodeURIComponent(query) +
		"&count=" +
		String(maxResults);
	const res = await requestUrl({
		url,
		method: "GET",
		headers: {
			"X-Subscription-Token": apiKey,
			Accept: "application/json",
		},
		throw: false,
	});
	if (res.status >= 400) {
		throw new Error(`Brave ${res.status}: ${res.text.slice(0, 200)}`);
	}
	const body = res.json as BraveResponse | undefined;
	const raw = Array.isArray(body?.web?.results) ? body!.web!.results! : [];
	const results: WebSearchResult[] = raw
		.map((r) => ({
			title: typeof r.title === "string" ? stripHtml(r.title) : "",
			url: typeof r.url === "string" ? r.url : "",
			snippet:
				typeof r.description === "string" ? stripHtml(r.description) : "",
		}))
		.filter((r) => r.url.length > 0);
	return { results };
}

function stripHtml(s: string): string {
	// Brave wraps matched terms in <strong>; the model doesn't need the markup.
	return s.replace(/<[^>]+>/g, "");
}

function renderResults(
	query: string,
	provider: WebSearchProvider,
	results: WebSearchResult[],
	answer: string | undefined,
): string {
	if (results.length === 0 && !answer) {
		return `No web results for "${query}" via ${provider}.`;
	}
	const parts: string[] = [];
	if (answer) {
		parts.push(`Synthesized answer (${provider}):`, "", answer, "");
	}
	if (results.length > 0) {
		parts.push(
			`${results.length} result${results.length === 1 ? "" : "s"} for "${query}" via ${provider}:`,
		);
		for (const r of results) {
			parts.push(`- [${r.title || r.url}](${r.url})`);
			if (r.snippet.length > 0) {
				parts.push(`  > ${truncate(r.snippet, 240)}`);
			}
		}
	}
	return parts.join("\n");
}

function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}
