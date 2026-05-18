import * as obsidian from "obsidian";
import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidipiPlugin from "./main";

export type Provider = "anthropic" | "google" | "openai" | "openrouter" | "deepseek";

export type WebSearchProvider = "tavily" | "brave";
export type WebSearchProviderSetting = WebSearchProvider | "off";

export interface ObsidipiSettings {
	provider: Provider;
	model: string;
	apiKeyOrSecretName: string;
	webSearchProvider: WebSearchProviderSetting;
	webSearchApiKeyOrSecretName: string;
}

export const DEFAULT_SETTINGS: ObsidipiSettings = {
	provider: "deepseek",
	model: "deepseek-chat",
	apiKeyOrSecretName: "",
	webSearchProvider: "off",
	webSearchApiKeyOrSecretName: "",
};

const PROVIDER_LABELS: Record<Provider, string> = {
	anthropic: "Anthropic",
	google: "Google (Gemini)",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	deepseek: "DeepSeek",
};

const WEB_SEARCH_LABELS: Record<WebSearchProviderSetting, string> = {
	off: "Off",
	tavily: "Tavily",
	brave: "Brave",
};

export class ObsidipiSettingTab extends PluginSettingTab {
	plugin: ObsidipiPlugin;

	constructor(app: App, plugin: ObsidipiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Which model backend to call.")
			.addDropdown((dd) => {
				for (const [value, label] of Object.entries(PROVIDER_LABELS)) {
					dd.addOption(value, label);
				}
				dd.setValue(this.plugin.settings.provider).onChange(async (value) => {
					this.plugin.settings.provider = value as Provider;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model identifier for this provider, like deepseek-chat or deepseek-reasoner.")
			.addText((text) =>
				text
					.setPlaceholder("Model identifier")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		this.renderSecretSetting(containerEl, {
			name: "API key",
			value: this.plugin.settings.apiKeyOrSecretName,
			onChange: (value) => {
				this.plugin.settings.apiKeyOrSecretName = value;
			},
		});

		containerEl.createEl("h3", { text: "Web search" });

		new Setting(containerEl)
			.setName("Web search provider")
			.setDesc("Adds a `web_search` tool the model can call. Off by default.")
			.addDropdown((dd) => {
				for (const [value, label] of Object.entries(WEB_SEARCH_LABELS)) {
					dd.addOption(value, label);
				}
				dd.setValue(this.plugin.settings.webSearchProvider).onChange(async (value) => {
					this.plugin.settings.webSearchProvider = value as WebSearchProviderSetting;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (this.plugin.settings.webSearchProvider !== "off") {
			this.renderSecretSetting(containerEl, {
				name: "Web search API key",
				value: this.plugin.settings.webSearchApiKeyOrSecretName,
				onChange: (value) => {
					this.plugin.settings.webSearchApiKeyOrSecretName = value;
				},
			});
		}
	}

	private renderSecretSetting(
		containerEl: HTMLElement,
		opts: {
			name: string;
			value: string;
			onChange: (value: string) => void;
		},
	) {
		const SecretComponentCtor = (obsidian as { SecretComponent?: typeof obsidian.SecretComponent })
			.SecretComponent;

		const setting = new Setting(containerEl).setName(opts.name);

		if (SecretComponentCtor) {
			setting
				.setDesc(
					"Pick or create an Obsidian secret. The value stays out of plugin data.json and is stored on this device.",
				)
				.addComponent((el: HTMLElement) =>
					new SecretComponentCtor(this.app, el)
						.setValue(opts.value)
						.onChange(async (value) => {
							opts.onChange(value);
							await this.plugin.saveSettings();
						}),
				);
		} else {
			setting
				.setDesc(
					"Stored in plugin data.json on this device as plaintext. Upgrade Obsidian to use the secret picker.",
				)
				.addText((text) =>
					text
						.setPlaceholder("Paste key")
						.setValue(opts.value)
						.onChange(async (value) => {
							opts.onChange(value.trim());
							await this.plugin.saveSettings();
						}),
				);
		}
	}
}

// `app.secretStorage` shipped in Obsidian 1.11.4 (matches manifest.minAppVersion).
// When the runtime API is present, `apiKeyOrSecretName` is treated as a secret
// id and the actual value is fetched from per-device storage outside data.json
// (so it isn't synced via Obsidian Sync or iCloud). Older builds fall back to
// reading the raw key from settings as plaintext.
export function resolveApiKey(app: App, settings: ObsidipiSettings): string | null {
	if (!settings.apiKeyOrSecretName) return null;
	if (!app.secretStorage) return settings.apiKeyOrSecretName;
	return app.secretStorage.getSecret(settings.apiKeyOrSecretName);
}

// Same secretStorage contract as resolveApiKey, but for the web-search
// provider's separate key. Returns null if web search is off OR the user
// hasn't entered a key yet — the tool surfaces the latter as an error the
// model can relay to the user.
export function resolveWebSearchApiKey(
	app: App,
	settings: ObsidipiSettings,
): string | null {
	if (settings.webSearchProvider === "off") return null;
	if (!settings.webSearchApiKeyOrSecretName) return null;
	if (!app.secretStorage) return settings.webSearchApiKeyOrSecretName;
	return app.secretStorage.getSecret(settings.webSearchApiKeyOrSecretName);
}
