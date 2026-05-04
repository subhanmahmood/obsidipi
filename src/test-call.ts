import { requestUrl } from "obsidian";
import type { Provider } from "./settings";

const TEST_PROMPT = "Reply with exactly the word: pong";

export async function callOnce(
	provider: Provider,
	model: string,
	apiKey: string,
): Promise<string> {
	switch (provider) {
		case "google":
			return callGemini(model, apiKey);
		case "anthropic":
			return callAnthropic(model, apiKey);
		case "openai":
			return callOpenAI("https://api.openai.com/v1", model, apiKey);
		case "openrouter":
			return callOpenAI("https://openrouter.ai/api/v1", model, apiKey);
		case "deepseek":
			return callOpenAI("https://api.deepseek.com/v1", model, apiKey);
	}
}

async function callGemini(model: string, apiKey: string): Promise<string> {
	const res = await requestUrl({
		url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
		}),
		throw: false,
	});
	if (res.status >= 400) throw new Error(`Gemini ${res.status}: ${res.text.slice(0, 200)}`);
	const text = res.json?.candidates?.[0]?.content?.parts?.[0]?.text;
	if (typeof text !== "string") throw new Error(`Gemini: no text in response`);
	return text.trim();
}

async function callAnthropic(model: string, apiKey: string): Promise<string> {
	const res = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		contentType: "application/json",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model,
			max_tokens: 64,
			messages: [{ role: "user", content: TEST_PROMPT }],
		}),
		throw: false,
	});
	if (res.status >= 400) throw new Error(`Anthropic ${res.status}: ${res.text.slice(0, 200)}`);
	const text = res.json?.content?.[0]?.text;
	if (typeof text !== "string") throw new Error(`Anthropic: no text in response`);
	return text.trim();
}

async function callOpenAI(baseUrl: string, model: string, apiKey: string): Promise<string> {
	const res = await requestUrl({
		url: `${baseUrl}/chat/completions`,
		method: "POST",
		contentType: "application/json",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: TEST_PROMPT }],
		}),
		throw: false,
	});
	if (res.status >= 400) throw new Error(`OpenAI ${res.status}: ${res.text.slice(0, 200)}`);
	const text = res.json?.choices?.[0]?.message?.content;
	if (typeof text !== "string") throw new Error(`OpenAI: no text in response`);
	return text.trim();
}
