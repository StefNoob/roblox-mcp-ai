export type ActivationSource = "manual" | "startup";

export interface ActivationOptions {
	showUi: boolean;
	sendImmediatePing: boolean;
	bootstrapRetryCount: number;
	bootstrapRetryDelaySeconds: number;
}

export function getActivationOptions(source: ActivationSource): ActivationOptions {
	return {
		showUi: source === "manual",
		sendImmediatePing: true,
		bootstrapRetryCount: source === "startup" ? 5 : 2,
		bootstrapRetryDelaySeconds: source === "startup" ? 1 : 0.5,
	};
}
