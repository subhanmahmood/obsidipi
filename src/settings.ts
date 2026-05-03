import * as obsidian from "obsidian";
import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidipiPlugin from "./main";

export type Provider = "anthropic" | "google" | "openai" | "openrouter";

export interface ObsidipiSettings {
	provider: Provider;
	model: string;
	apiKeyOrSecretName: string;
}

export const DEFAULT_SETTINGS: ObsidipiSettings = {
	provider: "google",
	model: "gemini-2.0-flash",
	apiKeyOrSecretName: "",
};

const PROVIDER_LABELS: Record<Provider, string> = {
	anthropic: "Anthropic",
	google: "Google (Gemini)",
	openai: "OpenAI",
	openrouter: "OpenRouter",
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
			.setDesc("Which LLM backend to call.")
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
			.setDesc("Provider-specific model id (e.g. gemini-2.0-flash, claude-sonnet-4-6).")
			.addText((text) =>
				text
					.setPlaceholder("model id")
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
					"Pick or create a secret in Obsidian's SecretStorage. The value is kept out of this plugin's data.json and is per-device.",
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
					"Stored in plugin data.json on this device (plaintext). Upgrade Obsidian to use the SecretStorage picker.",
				)
				.addText((text) =>
					text
						.setPlaceholder("paste API key")
						.setValue(this.plugin.settings.apiKeyOrSecretName)
						.onChange(async (value) => {
							this.plugin.settings.apiKeyOrSecretName = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}
	}
}

export function resolveApiKey(app: App, settings: ObsidipiSettings): string | null {
	if (!settings.apiKeyOrSecretName) return null;
	if (!app.secretStorage) return settings.apiKeyOrSecretName;
	return app.secretStorage.getSecret(settings.apiKeyOrSecretName);
}
