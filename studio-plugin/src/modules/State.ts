import { HttpService } from "@rbxts/services";
import { ActivityCategory, ActivityEntry, ActivityLevel, ActivityRetryContext, AgentSettings, AgentStatusInfo, AgentTask, ChatMessage, Connection, DirectCommand, LogEntry, PluginSettings, TaskStatus, TaskUpdate, ActiveTask, StepRecord, ArtifactRecord, TeamContext } from "../types";
import { createPluginSessionId } from "./PluginSession";

const CURRENT_VERSION = "__VERSION__";
const MAX_CONNECTIONS = 5;
const BASE_PORT = 3002;
const MAX_ACTIVITY_ITEMS = 120;
const MAX_TASKS = 50;
const MAX_LOG_ENTRIES = 200;
let activeTabIndex = 0;
let activityCounter = 0;
let taskCounter = 0;
let logCounter = 0;

const defaultSettings: PluginSettings = {
	parallelAgents: 2,
	useLightModel: false,
	useStructureMapping: true,
	autoPortDiscovery: true,
	verboseActivity: true,
	teamPreset: "balanced",
	reviewerLightMode: true,
	qaLightMode: true,
	orchestratorEnabled: true,
	agentTeams: {
		claude: { teamType: "claude", enabled: true, weight: 3, maxInFlight: 2, tokenMode: "standard" },
		codex: { teamType: "codex", enabled: true, weight: 2, maxInFlight: 2, tokenMode: "standard" },
		gemini: { teamType: "gemini", enabled: true, weight: 1, maxInFlight: 1, tokenMode: "light" },
	},
};

let pluginSettings: PluginSettings = { ...defaultSettings };
const activityItems: ActivityEntry[] = [];
const pluginSessionId = createPluginSessionId();
const agentChatMessages: Map<string, ChatMessage[]> = new Map();
const agentStatusMap: Map<string, AgentStatusInfo> = new Map();
const agentTasks: AgentTask[] = [];
const taskUpdateHandlers: ((update: TaskUpdate) => void)[] = [];
const logEntries: LogEntry[] = [];
const directCommands: DirectCommand[] = [];
let activeThreadId = "";
let agentSettings: AgentSettings = {
	agentPauseEnabled: false,
	maxTokensPerAgent: 100000,
	rateLimitPerSecond: 10,
	laneConfig: {
		core: { maxInFlight: 4, weight: 3 },
		reviewer: { maxInFlight: 2, weight: 1 },
		qa: { maxInFlight: 2, weight: 1 },
		background: { maxInFlight: 1, weight: 1 },
	},
};

let activeTask: ActiveTask = {
	goal: "",
	phase: "idle",
	stepIndex: 0,
	stepTotal: 0,
	reason: "",
	nextSuggestedAction: "",
};

const stepHistory: StepRecord[] = [];
const artifactRegistry: ArtifactRecord[] = [];

let teamContext: TeamContext = {
	selectedAgents: [],
	orchestratorMode: "balanced",
	activeAgents: [],
};

let onActiveTaskChanged: ((task: ActiveTask) => void) | undefined;
let onStepHistoryChanged: (() => void) | undefined;
let onArtifactRegistryChanged: (() => void) | undefined;
let onTeamContextChanged: ((ctx: TeamContext) => void) | undefined;

function setOnActiveTaskChanged(handler: (task: ActiveTask) => void): void {
	onActiveTaskChanged = handler;
}

function setOnStepHistoryChanged(handler: () => void): void {
	onStepHistoryChanged = handler;
}

function setOnArtifactRegistryChanged(handler: () => void): void {
	onArtifactRegistryChanged = handler;
}

function setOnTeamContextChanged(handler: (ctx: TeamContext) => void): void {
	onTeamContextChanged = handler;
}

function notifyActiveTaskChanged(task: ActiveTask): void {
	if (onActiveTaskChanged) {
		task.spawn(() => onActiveTaskChanged!(task));
	}
}

function notifyTeamContextChanged(ctx: TeamContext): void {
	if (onTeamContextChanged) {
		task.spawn(() => onTeamContextChanged!(ctx));
	}
}

function setTeamContext(ctx: TeamContext): void {
	teamContext = { ...ctx };
	notifyTeamContextChanged(teamContext);
}

function getTeamContext(): TeamContext {
	return { ...teamContext };
}

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

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
		lastMcpConnected: false,
		mcpWaitStartTime: undefined,
		isPolling: false,
		heartbeatConnection: undefined,
	};
}

function getServerHost(serverUrl: string): string {
	const withoutScheme = serverUrl.gsub("^https?://", "")[0];
	const [host] = withoutScheme.split(":");
	return tostring(host ?? "localhost");
}

function replaceConnectionPort(serverUrl: string, port: number): string {
	const [replaced, count] = serverUrl.gsub(":%d+$", `:${port}`);
	if (count > 0) {
		return replaced;
	}
	return `${serverUrl}:${port}`;
}

const connections: Connection[] = [createConnection(BASE_PORT)];

function addConnection(port?: number): number | undefined {
	if (arrayCount(connections) >= MAX_CONNECTIONS) {
		return undefined;
	}
	const lastPort = connections[arrayCount(connections) - 1].port;
	const conn = createConnection(port ?? lastPort + 1);
	connections.push(conn);
	return arrayCount(connections) - 1;
}

function removeConnection(index: number): boolean {
	if (arrayCount(connections) <= 1) return false;
	if (index < 0 || index >= arrayCount(connections)) return false;
	if (connections[index].isActive) return false;

	connections.remove(index);

	if (activeTabIndex >= arrayCount(connections)) {
		activeTabIndex = arrayCount(connections) - 1;
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

function getPluginSessionId(): string {
	return pluginSessionId;
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

function addActivity(
	level: ActivityLevel,
	category: ActivityCategory,
	title: string,
	detail: string,
	options?: {
		endpoint?: string;
		path?: string;
		payloadText?: string;
		errorText?: string;
		groupKey?: string;
		retryContext?: ActivityRetryContext;
	},
): ActivityEntry {
	activityCounter += 1;
	const item: ActivityEntry = {
		id: activityCounter,
		timestamp: tick(),
		level,
		category,
		title,
		detail,
		endpoint: options?.endpoint,
		path: options?.path,
		payloadText: options?.payloadText,
		errorText: options?.errorText,
		groupKey: options?.groupKey,
		retryContext: options?.retryContext,
	};
	activityItems.unshift(item);
	if (arrayCount(activityItems) > MAX_ACTIVITY_ITEMS) {
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

function addAgentChatMessage(threadId: string, message: ChatMessage): void {
	let messages = agentChatMessages.get(threadId);
	if (!messages) {
		messages = [];
		agentChatMessages.set(threadId, messages);
	}
	messages.push(message);
	if (messages.size() > 100) {
		messages.shift();
	}
}

function getAgentChatMessages(threadId: string): ChatMessage[] {
	return agentChatMessages.get(threadId) ?? [];
}

function setActiveThreadId(threadId: string): void {
	activeThreadId = threadId;
}

function getActiveThreadId(): string {
	return activeThreadId;
}

function updateAgentStatus(agentId: string, status: AgentStatusInfo): void {
	agentStatusMap.set(agentId, status);
}

function getAgentStatus(agentId: string): AgentStatusInfo | undefined {
	return agentStatusMap.get(agentId);
}

function getAllAgentStatus(): AgentStatusInfo[] {
	const result: AgentStatusInfo[] = [];
	agentStatusMap.forEach((status) => {
		result.push(status);
	});
	return result;
}

function getAgentSettings(): AgentSettings {
	return { ...agentSettings };
}

function updateAgentSettings(patch: Partial<AgentSettings>): AgentSettings {
	agentSettings = { ...agentSettings, ...patch };
	return { ...agentSettings };
}

function addTask(title: string, description: string, agentId?: string): AgentTask {
	taskCounter += 1;
	const task: AgentTask = {
		id: `task_${taskCounter}_${tick()}`,
		title,
		description,
		status: "pending",
		progress: 0,
		createdAt: tick(),
		updatedAt: tick(),
		agentId,
	};
	agentTasks.unshift(task);
	if (arrayCount(agentTasks) > MAX_TASKS) {
		agentTasks.pop();
	}
	return task;
}

function updateTask(taskId: string, update: Partial<AgentTask>): AgentTask | undefined {
	for (const task of agentTasks) {
		if (task.id === taskId) {
			task.status = update.status ?? task.status;
			task.progress = update.progress ?? task.progress;
			task.updatedAt = tick();
			if (update.result !== undefined) task.result = update.result;
			if (update.error !== undefined) task.error = update.error;
			if (update.agentId !== undefined) task.agentId = update.agentId;
			notifyTaskUpdateHandlers({ taskId, status: task.status, progress: task.progress });
			return task;
		}
	}
	return undefined;
}

function cancelTask(taskId: string): boolean {
	return updateTask(taskId, { status: "cancelled" }) !== undefined;
}

function getTasks(): AgentTask[] {
	return agentTasks;
}

function getTask(taskId: string): AgentTask | undefined {
	for (const task of agentTasks) {
		if (task.id === taskId) return task;
	}
	return undefined;
}

function onTaskUpdate(handler: (update: TaskUpdate) => void): () => void {
	taskUpdateHandlers.push(handler);
	return () => {
		const idx = taskUpdateHandlers.indexOf(handler);
		if (idx >= 0) taskUpdateHandlers.remove(idx);
	};
}

function notifyTaskUpdateHandlers(update: TaskUpdate) {
	for (const handler of taskUpdateHandlers) {
		task.spawn(() => handler(update));
	}
}

function addLog(level: LogEntry["level"], source: LogEntry["source"], message: string, taskId?: string): LogEntry {
	logCounter += 1;
	const entry: LogEntry = {
		id: `log_${logCounter}_${tick()}`,
		timestamp: tick(),
		level,
		source,
		message,
		taskId,
	};
	logEntries.unshift(entry);
	if (arrayCount(logEntries) > MAX_LOG_ENTRIES) {
		logEntries.pop();
	}
	return entry;
}

function getLogs(): LogEntry[] {
	return logEntries;
}

function clearLogs(): void {
	logEntries.clear();
}

function registerDirectCommand(name: string, description: string, endpoint: string, params?: Record<string, unknown>): DirectCommand {
	const id = `cmd_${name.toLowerCase().replace(/ /g, "_")}`;
	const cmd: DirectCommand = {
		id,
		name,
		description,
		endpoint,
		params,
	};
	directCommands.push(cmd);
	return cmd;
}

function getDirectCommands(): DirectCommand[] {
	return directCommands;
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
	getPluginSessionId,
	getDefaultSettings,
	setPluginSettings,
	updatePluginSettings,
	getPluginSettings,
	getServerHost,
	replaceConnectionPort,
	addActivity,
	getActivity,
	clearActivity,
	addAgentChatMessage,
	getAgentChatMessages,
	setActiveThreadId,
	getActiveThreadId,
	updateAgentStatus,
	getAgentStatus,
	getAllAgentStatus,
	getAgentSettings,
	updateAgentSettings,
	addTask,
	updateTask,
	cancelTask,
	getTasks,
	getTask,
	onTaskUpdate,
	addLog,
	getLogs,
	clearLogs,
	registerDirectCommand,
	getDirectCommands,
	setOnActiveTaskChanged,
	setOnStepHistoryChanged,
	setOnArtifactRegistryChanged,
	setOnTeamContextChanged,
	setTeamContext,
	getTeamContext,
};
