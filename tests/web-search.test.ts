import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the obsidian runtime — only `requestUrl` is touched by the SUT.
// `vi.mock` is hoisted so this runs before web-search.ts is loaded.
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import {
	webSearchTool,
	type WebSearchDetails,
	type WebSearchProvider,
} from "../src/web-search";
import { createMockApp } from "./mock-obsidian";

const requestUrlMock = requestUrl as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	requestUrlMock.mockReset();
});

function mockOk(body: unknown) {
	requestUrlMock.mockResolvedValueOnce({
		status: 200,
		text: JSON.stringify(body),
		json: body,
	});
}

function mockFail(status: number, text = "auth error") {
	requestUrlMock.mockResolvedValueOnce({
		status,
		text,
		json: null,
	});
}

function makeTool(
	provider: WebSearchProvider | "off",
	apiKey: string | null = "test-key",
) {
	const { app } = createMockApp();
	return webSearchTool(
		app,
		() => apiKey,
		() => provider,
	);
}

describe("web_search — Tavily", () => {
	it("parses Tavily results and includes the synthesized answer", async () => {
		mockOk({
			answer: "obsidian 1.12 ships cache components",
			results: [
				{
					title: "Obsidian 1.12",
					url: "https://example.com/a",
					content: "Release notes here",
					score: 0.9,
				},
				{
					title: "Forum thread",
					url: "https://example.com/b",
					content: "Discussion",
				},
			],
		});
		const tool = makeTool("tavily");
		const out = await tool.execute("call-1", { query: "obsidian 1.12" });
		const details = out.details as WebSearchDetails;
		expect(details.provider).toBe("tavily");
		expect(details.results).toHaveLength(2);
		expect(details.results[0]?.title).toBe("Obsidian 1.12");
		expect(details.results[0]?.url).toBe("https://example.com/a");
		expect(details.results[0]?.snippet).toBe("Release notes here");
		expect(details.answer).toBe("obsidian 1.12 ships cache components");

		const text = (out.content[0] as { text: string }).text;
		expect(text).toContain("Synthesized answer (tavily)");
		expect(text).toContain("[Obsidian 1.12](https://example.com/a)");
		expect(text).toContain("> Release notes here");
	});

	it("sends api_key, query, max_results, and include_answer in the body", async () => {
		mockOk({ results: [] });
		const tool = makeTool("tavily");
		await tool.execute("call-1", { query: "x", maxResults: 3 });
		const call = requestUrlMock.mock.calls[0]?.[0] as {
			url: string;
			method: string;
			body: string;
		};
		expect(call.url).toBe("https://api.tavily.com/search");
		expect(call.method).toBe("POST");
		const body = JSON.parse(call.body) as Record<string, unknown>;
		expect(body.api_key).toBe("test-key");
		expect(body.query).toBe("x");
		expect(body.max_results).toBe(3);
		expect(body.include_answer).toBe(true);
	});

	it("defaults maxResults to 5 when omitted", async () => {
		mockOk({ results: [] });
		const tool = makeTool("tavily");
		await tool.execute("call-1", { query: "x" });
		const call = requestUrlMock.mock.calls[0]?.[0] as { body: string };
		const body = JSON.parse(call.body) as Record<string, unknown>;
		expect(body.max_results).toBe(5);
	});

	it("clamps maxResults above 10", async () => {
		mockOk({ results: [] });
		const tool = makeTool("tavily");
		await tool.execute("call-1", { query: "x", maxResults: 50 });
		const call = requestUrlMock.mock.calls[0]?.[0] as { body: string };
		const body = JSON.parse(call.body) as Record<string, unknown>;
		expect(body.max_results).toBe(10);
	});

	it("surfaces a clean error message on HTTP 401", async () => {
		mockFail(401, "invalid api key");
		const tool = makeTool("tavily");
		await expect(
			tool.execute("call-1", { query: "x" }),
		).rejects.toThrow(/Tavily 401/);
	});
});

describe("web_search — Brave", () => {
	it("parses Brave web.results into the normalized shape", async () => {
		mockOk({
			web: {
				results: [
					{
						title: "Page <strong>One</strong>",
						url: "https://b.example/1",
						description: "First <strong>match</strong>",
					},
					{
						title: "Two",
						url: "https://b.example/2",
						description: "Second",
					},
				],
			},
		});
		const tool = makeTool("brave");
		const out = await tool.execute("call-1", { query: "test" });
		const details = out.details as WebSearchDetails;
		expect(details.results).toHaveLength(2);
		// HTML tags get stripped so the model sees plain text
		expect(details.results[0]?.title).toBe("Page One");
		expect(details.results[0]?.snippet).toBe("First match");
		expect(details.answer).toBeUndefined();
	});

	it("uses the GET pattern with X-Subscription-Token", async () => {
		mockOk({ web: { results: [] } });
		const tool = makeTool("brave", "brave-key");
		await tool.execute("call-1", { query: "hello world", maxResults: 4 });
		const call = requestUrlMock.mock.calls[0]?.[0] as {
			url: string;
			method: string;
			headers: Record<string, string>;
		};
		expect(call.method).toBe("GET");
		expect(call.url).toContain("https://api.search.brave.com/res/v1/web/search");
		expect(call.url).toContain("q=hello%20world");
		expect(call.url).toContain("count=4");
		expect(call.headers["X-Subscription-Token"]).toBe("brave-key");
	});
});

describe("web_search — failure modes", () => {
	it("throws when web search is off", async () => {
		const tool = makeTool("off");
		await expect(
			tool.execute("call-1", { query: "x" }),
		).rejects.toThrow(/disabled/);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("throws when no API key is configured", async () => {
		const tool = makeTool("tavily", null);
		await expect(
			tool.execute("call-1", { query: "x" }),
		).rejects.toThrow(/No API key configured/);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("renders an empty-result message when results are empty and no answer", async () => {
		mockOk({ results: [] });
		const tool = makeTool("tavily");
		const out = await tool.execute("call-1", { query: "nothing" });
		const text = (out.content[0] as { text: string }).text;
		expect(text).toMatch(/No web results for "nothing"/);
	});
});
