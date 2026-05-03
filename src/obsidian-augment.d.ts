import "obsidian";
import type { App, ValueComponent } from "obsidian";

/*
 * SecretStorage / SecretComponent ship at runtime in recent Obsidian builds
 * (see https://docs.obsidian.md/plugins/guides/secret-storage) but aren't in
 * the published typings yet. We declare them here and feature-detect at runtime.
 */
declare module "obsidian" {
	interface App {
		secretStorage?: SecretStorage;
	}

	export class SecretStorage {
		getSecret(id: string): string | null;
		setSecret(id: string, secret: string): Promise<void>;
		listSecrets(): string[];
	}

	export class SecretComponent extends ValueComponent<string> {
		constructor(app: App, containerEl: HTMLElement);
		getValue(): string;
		setValue(value: string): this;
		onChange(callback: (value: string) => unknown): this;
	}

	interface Setting {
		addComponent(cb: (containerEl: HTMLElement) => unknown): this;
	}
}
