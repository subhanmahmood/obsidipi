import { Notice, Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ObsidipiSettings,
	ObsidipiSettingTab,
	resolveApiKey,
} from "./settings";
import { callOnce } from "./test-call";

export default class ObsidipiPlugin extends Plugin {
	settings: ObsidipiSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ObsidipiSettingTab(this.app, this));

		this.addCommand({
			id: "test-api-key",
			name: "Test API key",
			callback: () => {
				void this.runTestCall();
			},
		});
	}

	private async runTestCall() {
		console.log("[obsidipi] test call: start", {
			provider: this.settings.provider,
			model: this.settings.model,
			secretName: this.settings.apiKeyOrSecretName,
			hasSecretStorage: !!this.app.secretStorage,
		});
		const { provider, model } = this.settings;
		const apiKey = resolveApiKey(this.app, this.settings);
		if (!apiKey) {
			new Notice("Obsidipi: no API key configured", 8000);
			return;
		}
		if (!model) {
			new Notice("Obsidipi: no model configured", 8000);
			return;
		}
		console.log("[obsidipi] test call: keyResolved", {
			keyLength: apiKey.length,
			keyPrefix: apiKey.slice(0, 4),
			isSecretName: apiKey === this.settings.apiKeyOrSecretName,
		});
		new Notice(`Obsidipi: calling ${provider} (${model})…`, 4000);
		try {
			const reply = await callOnce(provider, model, apiKey);
			console.log("[obsidipi] test call: success", reply);
			new Notice(`Obsidipi reply: ${reply}`, 12000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[obsidipi] test call: failed", err);
			new Notice(`Obsidipi failed: ${msg}`, 12000);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ObsidipiSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
