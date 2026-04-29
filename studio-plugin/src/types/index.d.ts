/// <reference types="@rbxts/types/plugin" />

export interface Connection {
	port: number;
	serverUrl: string;
	isActive: boolean;
	pollInterval: number;
	lastPoll: number;
	consecutiveFailures: number;
	maxFailuresBeforeError: number;
	lastSuccessfulConnection: number;
	currentRetryDelay: number;
	maxRetryDelay: number;
	retryBackoffMultiplier: number;
	lastHttpOk: boolean;
	mcpWaitStartTime?: number;
	isPolling: boolean;
	heartbeatConnection?: RBXScriptConnection;
}

export type ActivityLevel = "info" | "success" | "warn" | "error";

export interface ActivityEntry {
	id: number;
	timestamp: number;
	level: ActivityLevel;
	title: string;
	detail: string;
	endpoint?: string;
}

export interface PluginSettings {
	parallelAgents: number;
	useLightModel: boolean;
	useStructureMapping: boolean;
	autoPortDiscovery: boolean;
	verboseActivity: boolean;
}

export interface RequestData {
	[key: string]: unknown;
}

export interface RequestPayload {
	endpoint: string;
	data?: RequestData;
}

export interface PollResponse {
	mcpConnected: boolean;
	request?: RequestPayload;
	requestId?: string;
}


declare global {
	function loadstring(code: string): LuaTuple<[(() => unknown) | undefined, string?]>;
}
