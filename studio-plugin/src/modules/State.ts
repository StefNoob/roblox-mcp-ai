import { ActivityEntry, ActivityLevel, Connection, PluginSettings } from "../types";

const CURRENT_VERSION = "__VERSION__";
const MAX_CONNECTIONS = 5;
const BASE_PORT = 3002;
const MAX_ACTIVITY_ITEMS = 120;
let activeTabIndex = 0;
let activityCounter = 0;

const defaultSettings: PluginSettings = {
	parallelAgents: 2,
	useLightModel: false,
	useStructureMapping: true,
	autoPortDiscovery: true,
	verboseActivity: true,
};

let pluginSettings: PluginSettings = { ...defaultSettings };
const activityItems: ActivityEntry[] = [];

function createConnection(port: number): Connection {
	return {
		port,
		serverUrl: `http://localhost:${port}`,
		isActive: false,
		pollInterval: 0.5,
		lastPoll: 0,
		consecutiveFailures: 0,
		maxFailuresBeforeError: 50,
		lastSuccessfulConnection: 0,
		currentRetryDelay: 0.5,
		maxRetryDelay: 5,
		retryBackoffMultiplier: 1.2,
		lastHttpOk: false,
		mcpWaitStartTime: undefined,
		isPolling: false,
		heartbeatConnection: undefined,
	};
}

const connections: Connection[] = [createConnection(BASE_PORT)];

function addConnection(port?: number): number | undefined {
	if (connections.size() >= MAX_CONNECTIONS) {
		return undefined;
	}
	const lastPort = connections[connections.size() - 1].port;
	const conn = createConnection(port ?? lastPort + 1);
	connections.push(conn);
	return connections.size() - 1;
}

function removeConnection(index: number): boolean {
	if (connections.size() <= 1) return false;
	if (index < 0 || index >= connections.size()) return false;
	if (connections[index].isActive) return false;

	connections.remove(index);

	if (activeTabIndex >= connections.size()) {
		activeTabIndex = connections.size() - 1;
	} else if (activeTabIndex > index) {
		activeTabIndex -= 1;
	}
	return true;
}

function getActiveConnection(): Connection {
	return connections[activeTabIndex];
}

function getConnection(index: number): Connection | undefined {
	return connections[index];
}

function getActiveTabIndex(): number {
	return activeTabIndex;
}

function setActiveTabIndex(index: number): void {
	activeTabIndex = index;
}

function getConnections(): Connection[] {
	return connections;
}

function getDefaultSettings(): PluginSettings {
	return { ...defaultSettings };
}

function setPluginSettings(settings: PluginSettings): void {
	pluginSettings = { ...settings };
}

function updatePluginSettings(patch: Partial<PluginSettings>): PluginSettings {
	pluginSettings = { ...pluginSettings, ...patch };
	return { ...pluginSettings };
}

function getPluginSettings(): PluginSettings {
	return { ...pluginSettings };
}

function addActivity(level: ActivityLevel, title: string, detail: string, endpoint?: string): ActivityEntry {
	activityCounter += 1;
	const item: ActivityEntry = {
		id: activityCounter,
		timestamp: tick(),
		level,
		title,
		detail,
		endpoint,
	};
	activityItems.unshift(item);
	if (activityItems.size() > MAX_ACTIVITY_ITEMS) {
		activityItems.pop();
	}
	return item;
}

function getActivity(): ActivityEntry[] {
	return activityItems;
}

function clearActivity(): void {
	activityItems.clear();
}

export = {
	CURRENT_VERSION,
	MAX_CONNECTIONS,
	BASE_PORT,
	MAX_ACTIVITY_ITEMS,
	connections,
	addConnection,
	removeConnection,
	getActiveConnection,
	getConnection,
	getActiveTabIndex,
	setActiveTabIndex,
	getConnections,
	getDefaultSettings,
	setPluginSettings,
	updatePluginSettings,
	getPluginSettings,
	addActivity,
	getActivity,
	clearActivity,
};
