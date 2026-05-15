import * as obsidian from "obsidian";
import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidipiPlugin from "./main";

export type Provider = "anthropic" | "google" | "openai" | "openrouter" | "deepseek";

export interface ObsidipiSettings {
	provider: Provider;
	model: string;
	apiKeyOrSecretName: string;
}

export const DEFAULT_SETTINGS: ObsidipiSettings = {
	provider: "deepseek",
	model: "deepseek-chat",
	apiKeyOrSecretName: "",
};

const PROVIDER_LABELS: Record<Provider, string> = {
	anthropic: "Anthropic",
	google: "Google (Gemini)",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	deepseek: "DeepSeek",
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

		this.renderApiKeySetting(containerEl);
	}

	private renderApiKeySetting(containerEl: HTMLElement) {
		const SecretComponentCtor = (obsidian as { SecretComponent?: typeof obsidian.SecretComponent })
			.SecretComponent;

		const setting = new Setting(containerEl).setName("API key");

		if (SecretComponentCtor) {
			setting
				.setDesc(
					"Pick or create an Obsidian secret. The value stays out of plugin data.json and is stored on this device.",
				)
				.addComponent((el: HTMLElement) =>
					new SecretComponentCtor(this.app, el)
						.setValue(this.plugin.settings.apiKeyOrSecretName)
						.onChange(async (value) => {
							this.plugin.settings.apiKeyOrSecretName = value;
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
						.setValue(this.plugin.settings.apiKeyOrSecretName)
						.onChange(async (value) => {
							this.plugin.settings.apiKeyOrSecretName = value.trim();
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
