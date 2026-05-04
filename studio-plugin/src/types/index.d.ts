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
	lastMcpConnected: boolean;
	mcpWaitStartTime?: number;
	isPolling: boolean;
	heartbeatConnection?: RBXScriptConnection;
}

export type ActivityLevel = "info" | "success" | "warn" | "error";
export type ActivityCategory = "read" | "write" | "error" | "structure" | "system";

export interface ActivityRetryContext {
	endpoint: string;
	path?: string;
	payload?: unknown;
}

export interface ActivityEntry {
	id: number;
	timestamp: number;
	level: ActivityLevel;
	category: ActivityCategory;
	title: string;
	detail: string;
	endpoint?: string;
	path?: string;
	payloadText?: string;
	errorText?: string;
	groupKey?: string;
	retryContext?: ActivityRetryContext;
}

export type AgentTeamType = "claude" | "codex" | "gemini";

export interface AgentTeamConfig {
	teamType: AgentTeamType;
	enabled: boolean;
	weight: number;
	maxInFlight: number;
	tokenMode: "standard" | "light";
}

export interface PluginSettings {
	parallelAgents: number;
	useLightModel: boolean;
	useStructureMapping: boolean;
	autoPortDiscovery: boolean;
	verboseActivity: boolean;
	teamPreset: "balanced" | "throughput" | "tokenSaver";
	reviewerLightMode: boolean;
	qaLightMode: boolean;
	agentTeams: Record<AgentTeamType, AgentTeamConfig>;
	orchestratorEnabled: boolean;
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
	tasks?: TaskUpdate[];
}

export type ChatMessageRole = "user" | "assistant" | "system" | "error";

export interface ChatMessage {
	id: string;
	role: ChatMessageRole;
	content: string;
	timestamp: number;
	tokensIn?: number;
	tokensOut?: number;
}

export type AgentStatusType = "active" | "paused" | "stopped";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AgentTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	progress: number;
	createdAt: number;
	updatedAt: number;
	agentId?: string;
	result?: unknown;
	error?: string;
}

export interface AgentThreadInfo {
	threadId: string;
	agentId: string;
	status: AgentStatusType;
	messageCount: number;
	createdAt: number;
	lastActivityAt: number;
}

export interface AgentStatusInfo {
	agentId: string;
	threadId: string;
	status: AgentStatusType;
	tokensIn: number;
	tokensOut: number;
	avgLatencyMs: number;
	requestCount: number;
	lastActivityAt: number;
	threadCount: number;
}

export interface AgentMetricsInfo {
	tokensInTotal: number;
	tokensOutTotal: number;
	requestsTotal: number;
	avgLatencyMs: number;
	p50LatencyMs: number;
	p99LatencyMs: number;
	laneStats: Array<{
		lane: string;
		inFlight: number;
		pending: number;
		completed: number;
	}>;
}

export interface AgentChatResponse {
	success: boolean;
	response: string;
	agentId: string;
	threadId: string;
	tokensIn?: number;
	tokensOut?: number;
}

export interface LaneConfig {
	maxInFlight: number;
	weight: number;
}

export interface LogEntry {
	id: string;
	timestamp: number;
	level: "debug" | "info" | "warn" | "error";
	source: "agent" | "system" | "plugin" | "bridge";
	message: string;
	taskId?: string;
}

export interface DirectCommand {
	id: string;
	name: string;
	description: string;
	endpoint: string;
	params?: Record<string, unknown>;
}

export interface TaskUpdate {
	taskId: string;
	status: TaskStatus;
	progress: number;
	message?: string;
}

export interface AgentSettings {
	agentPauseEnabled: boolean;
	maxTokensPerAgent: number;
	rateLimitPerSecond: number;
	laneConfig: Record<string, LaneConfig>;
}

export type TaskPhase = "idle" | "planning" | "building" | "testing" | "reviewing" | "done" | "error";

export interface ActiveTask {
	goal: string;
	phase: TaskPhase;
	stepIndex: number;
	stepTotal: number;
	reason: string;
	nextSuggestedAction: string;
}

export interface StepRecord {
	id: string;
	phase: TaskPhase;
	title: string;
	detail: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	timestamp: number;
}

export type ArtifactKind = "Script" | "LocalScript" | "ModuleScript" | "Instance" | "Folder" | "Plugin" | "Other";

export interface ArtifactRecord {
	name: string;
	kind: ArtifactKind;
	status: "created" | "modified" | "deleted" | "stale";
	lastTouchedAt: number;
	path: string;
}

export interface TeamContext {
	selectedAgents: string[];
	orchestratorMode: "balanced" | "throughput" | "tokenSaver";
	activeAgents: string[];
}

export interface AgentContext {
	task: ActiveTask;
	artifacts: ArtifactRecord[];
	team: {
		active: string[];
		selected: string[];
	};
}


declare global {
	function loadstring(code: string): LuaTuple<[(() => unknown) | undefined, string?]>;
}
