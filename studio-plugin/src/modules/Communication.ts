import { HttpService, RunService } from "@rbxts/services";
import State from "./State";
import Utils from "./Utils";
import UI from "./UI";
import QueryHandlers from "./handlers/QueryHandlers";
import PropertyHandlers from "./handlers/PropertyHandlers";
import InstanceHandlers from "./handlers/InstanceHandlers";
import ScriptHandlers from "./handlers/ScriptHandlers";
import MetadataHandlers from "./handlers/MetadataHandlers";
import CrossSessionHandlers from "./handlers/CrossSessionHandlers";
import TestHandlers from "./handlers/TestHandlers";
import AITestHandlers from "./handlers/AITestHandlers";
import UIGeneratorHandlers from "./handlers/UIGeneratorHandlers";
import ContextHandlers from "./handlers/ContextHandlers";
import TaskHandlers from "./handlers/TaskHandlers";
import SwarmHandlers from "./handlers/SwarmHandlers";
import StructureMap from "./StructureMap";
import { describeWriteBlockReason, getStudioWriteState, shouldBlockWrite } from "./WriteSafety";
import {
	describePollFailure,
	isHandshakeHttpSuccess,
	isPollHttpSuccess,
} from "./PollResult";
import { deriveConnectionPhase } from "./ConnectionStatus";
import { ActivationOptions } from "./ActivationMode";
import { ActivityRetryContext, Connection, PluginSettings, RequestPayload, PollResponse } from "../types";

type Handler = (data: Record<string, unknown>) => unknown;

const routeMap: Record<string, Handler> = {

	"/api/file-tree": QueryHandlers.getFileTree,
	"/api/search-files": QueryHandlers.searchFiles,
	"/api/place-info": QueryHandlers.getPlaceInfo,
	"/api/services": QueryHandlers.getServices,
	"/api/search-objects": QueryHandlers.searchObjects,
	"/api/instance-properties": QueryHandlers.getInstanceProperties,
	"/api/instance-children": QueryHandlers.getInstanceChildren,
	"/api/search-by-property": QueryHandlers.searchByProperty,
	"/api/class-info": QueryHandlers.getClassInfo,
	"/api/project-structure": QueryHandlers.getProjectStructure,
	"/api/structure-map-summary": StructureMap.getStructureMapSummary,
	"/api/query-structure-map": StructureMap.queryStructureMap,
	"/api/script-inventory": StructureMap.getScriptInventory,
	"/api/refresh-structure-map": StructureMap.refreshStructureMap,

	"/api/set-property": PropertyHandlers.setProperty,
	"/api/mass-set-property": PropertyHandlers.massSetProperty,
	"/api/mass-get-property": PropertyHandlers.massGetProperty,
	"/api/set-calculated-property": PropertyHandlers.setCalculatedProperty,
	"/api/set-relative-property": PropertyHandlers.setRelativeProperty,

	"/api/create-object": InstanceHandlers.createObject,
	"/api/mass-create-objects": InstanceHandlers.massCreateObjects,
	"/api/mass-create-objects-with-properties": InstanceHandlers.massCreateObjectsWithProperties,
	"/api/delete-object": InstanceHandlers.deleteObject,
	"/api/smart-duplicate": InstanceHandlers.smartDuplicate,
	"/api/mass-duplicate": InstanceHandlers.massDuplicate,

	"/api/get-script-source": ScriptHandlers.getScriptSource,
	"/api/get-script-metadata": ScriptHandlers.getScriptMetadata,
	"/api/set-script-source": ScriptHandlers.setScriptSource,
	"/api/edit-script-lines": ScriptHandlers.editScriptLines,
	"/api/insert-script-lines": ScriptHandlers.insertScriptLines,
	"/api/delete-script-lines": ScriptHandlers.deleteScriptLines,

	"/api/get-attribute": MetadataHandlers.getAttribute,
	"/api/set-attribute": MetadataHandlers.setAttribute,
	"/api/get-attributes": MetadataHandlers.getAttributes,
	"/api/delete-attribute": MetadataHandlers.deleteAttribute,
	"/api/get-tags": MetadataHandlers.getTags,
	"/api/add-tag": MetadataHandlers.addTag,
	"/api/remove-tag": MetadataHandlers.removeTag,
	"/api/get-tagged": MetadataHandlers.getTagged,
	"/api/get-selection": MetadataHandlers.getSelection,
	"/api/execute-luau": MetadataHandlers.executeLuau,
	"/api/export-instance-snapshot": CrossSessionHandlers.exportInstanceSnapshot,
	"/api/import-instance-snapshot": CrossSessionHandlers.importInstanceSnapshot,

"/api/start-playtest": TestHandlers.startPlaytest,
	"/api/stop-playtest": TestHandlers.stopPlaytest,
	"/api/get-playtest-output": TestHandlers.getPlaytestOutput,

	"/api/ai-control-player": AITestHandlers.aiControlPlayer,
	"/api/ai-get-player-state": AITestHandlers.aiGetPlayerState,
	"/api/ai-interact-with-object": AITestHandlers.aiInteractWithObject,
	"/api/ai-teleport-player": AITestHandlers.aiTeleportPlayer,
	"/api/get-game-state": AITestHandlers.getGameState,
	"/api/capture-debug-logs": AITestHandlers.captureDebugLogs,
	"/api/get-runtime-errors": AITestHandlers.getRuntimeErrors,
	"/api/execute-test-sequence": AITestHandlers.executeTestSequence,
	"/api/watch-property-changes": AITestHandlers.watchPropertyChanges,
	"/api/get-performance-metrics": AITestHandlers.getPerformanceMetrics,
	"/api/inspect-terrain": AITestHandlers.inspectTerrain,
	"/api/get-network-stats": AITestHandlers.getNetworkStats,
	"/api/simulate-input": AITestHandlers.simulateInput,
	"/api/generate-ui": UIGeneratorHandlers.generateUI,

	"/api/agent/chat": (data) => {
		const message = (data.message as string) ?? "";
		const agentId = (data.agentId as string) ?? "default";
		const threadId = (data.threadId as string) ?? undefined;
		const tokensIn = math.ceil(message.size() / 4);
		const msgId = `msg_${tick()}_${math.random() * 99999}`;
		const chatMsg = {
			id: msgId,
			role: "user" as const,
			content: message,
			timestamp: tick(),
			tokensIn,
		};
		let effectiveThreadId = threadId ?? State.getActiveThreadId();
		if (!effectiveThreadId || effectiveThreadId === "") {
			effectiveThreadId = `th_${math.floor(math.random() * 999999)}`;
		}
		State.addAgentChatMessage(effectiveThreadId, chatMsg);
		State.setActiveThreadId(effectiveThreadId);
		const responseContent = `[Plugin Chat] Message received: "${message}". Agent ID: ${agentId}, Thread: ${effectiveThreadId}`;
		const assistantMsg = {
			id: `msg_${tick()}_${math.random() * 99999 + 1}`,
			role: "assistant" as const,
			content: responseContent,
			timestamp: tick(),
			tokensOut: math.ceil(responseContent.size() / 4),
		};
		State.addAgentChatMessage(effectiveThreadId, assistantMsg);
		return {
			success: true,
			response: responseContent,
			agentId,
			threadId: effectiveThreadId,
			tokensIn,
			tokensOut: assistantMsg.tokensOut,
		};
	},
	"/api/agent/status": () => {
		return {
			agents: State.getAllAgentStatus(),
			totalTokensIn: 0,
			totalTokensOut: 0,
			activeAgentCount: 0,
		};
	},
	"/api/agent/control": (data) => {
		const action = data.action as string;
		const agentId = (data.agentId as string) ?? "default";
		let success = false;
		let affectedAgents: string[] = [];
		if (action === "pause" || action === "resume" || action === "stop") {
			const settings = State.getAgentSettings();
			if (action === "pause") {
				State.updateAgentSettings({ agentPauseEnabled: true });
				success = true;
			} else if (action === "resume") {
				State.updateAgentSettings({ agentPauseEnabled: false });
				success = true;
			} else if (action === "stop") {
				State.updateAgentSettings({ agentPauseEnabled: false });
				success = true;
			}
			affectedAgents = [agentId];
		}
		return { success, affectedAgents };
	},
	"/api/agent/threads": () => {
		return {
			threads: [] as Array<{
				threadId: string;
				agentId: string;
				status: string;
				messageCount: number;
				createdAt: number;
			}>,
		};
	},
	"/api/agent/metrics": () => {
		const settings = State.getAgentSettings();
		return {
			tokensInTotal: 0,
			tokensOutTotal: 0,
			requestsTotal: 0,
			avgLatencyMs: 0,
			p50LatencyMs: 0,
			p99LatencyMs: 0,
			laneStats: [
				{ lane: "core", inFlight: 0, pending: 0, completed: 0 },
				{ lane: "reviewer", inFlight: 0, pending: 0, completed: 0 },
				{ lane: "qa", inFlight: 0, pending: 0, completed: 0 },
				{ lane: "background", inFlight: 0, pending: 0, completed: 0 },
			],
			rateLimitPerSecond: settings.rateLimitPerSecond,
			maxTokensPerAgent: settings.maxTokensPerAgent,
			agentPauseEnabled: settings.agentPauseEnabled,
		};
	},

	"/api/context/relevant-files": ContextHandlers.getRelevantFiles,
	"/api/context/load": ContextHandlers.loadContext,
	"/api/context/update-focus": ContextHandlers.updateAgentFocus,
	"/api/context/get-focus": ContextHandlers.getAgentFocus,
	"/api/context/refresh-cache": ContextHandlers.refreshContextCache,
	"/api/context/invalidate-stale": ContextHandlers.invalidateStaleFiles,

	"/api/task/create": TaskHandlers.createTask,
	"/api/task/start": TaskHandlers.startTask,
	"/api/task/complete": TaskHandlers.completeTask,
	"/api/task/fail": TaskHandlers.failTask,
	"/api/task/get": TaskHandlers.getTask,
	"/api/task/list": TaskHandlers.getTasks,
	"/api/task/summary": TaskHandlers.getTaskSummary,
	"/api/task/recent": TaskHandlers.getRecentTasks,
	"/api/task/by-subsystem": TaskHandlers.getTasksBySubsystem,
	"/api/task/by-agent": TaskHandlers.getTasksByAgent,
	"/api/task/clear-completed": TaskHandlers.clearCompletedTasks,
	"/api/task/cancel": TaskHandlers.cancelTask,

	"/api/swarm/status": SwarmHandlers.getSwarmStatus,
	"/api/swarm/metrics": SwarmHandlers.getSwarmMetrics,
	"/api/swarm/command": SwarmHandlers.executeAgentCommand,
	"/api/swarm/lanes": SwarmHandlers.getLaneAssignments,
	"/api/swarm/best-lane": SwarmHandlers.getBestAvailableLane,
	"/api/swarm/record-activity": SwarmHandlers.recordLaneActivity,
	"/api/swarm/sync-tasks": SwarmHandlers.syncWithTaskHistory,
};

const STRUCTURE_MAP_ENDPOINTS = new Set<string>([
	"/api/structure-map-summary",
	"/api/query-structure-map",
	"/api/script-inventory",
	"/api/refresh-structure-map",
]);

const WRITE_ENDPOINTS = new Set<string>([
	"/api/set-property",
	"/api/mass-set-property",
	"/api/set-calculated-property",
	"/api/set-relative-property",
	"/api/create-object",
	"/api/mass-create-objects",
	"/api/mass-create-objects-with-properties",
	"/api/delete-object",
	"/api/smart-duplicate",
	"/api/mass-duplicate",
	"/api/set-script-source",
	"/api/edit-script-lines",
	"/api/insert-script-lines",
	"/api/delete-script-lines",
	"/api/set-attribute",
	"/api/delete-attribute",
	"/api/add-tag",
	"/api/remove-tag",
	"/api/import-instance-snapshot",
]);

let lastDiagnosticsPollAt = 0;

type DiagnosticsResponse = {
	bridge?: Record<string, unknown>;
	plugin?: {
		connected?: boolean;
		polling?: boolean;
		capabilities?: Record<string, boolean>;
	};
	mcpServerActive?: boolean;
	serverCapabilities?: Record<string, boolean>;
	writeQueue?: { inFlight?: unknown; pending?: number };
	recentErrors?: Array<{ endpoint?: string; message?: string; timestamp?: number }>;
	runtime?: {
		structureMap?: {
			cache?: {
				cached?: boolean;
				summaryCount?: number;
				freshSummaryCount?: number;
				staleSummaryCount?: number;
				sourceCount?: number;
			};
		};
	};
};

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

function log(
	level: "info" | "success" | "warn" | "error",
	title: string,
	detail: string,
	options?: string | {
		endpoint?: string;
		category?: "read" | "write" | "error" | "structure" | "system";
		path?: string;
		payload?: unknown;
		error?: unknown;
		retryContext?: ActivityRetryContext;
	},
) {
	UI.pushActivity(level, title, detail, options);
}

function isStructureMapEnabled(): boolean {
	return State.getPluginSettings().useStructureMapping;
}

function buildTeamOrchestratorProfile(settings: PluginSettings): Record<string, unknown> {
	const isThroughput = settings.teamPreset === "throughput";
	const isTokenSaver = settings.teamPreset === "tokenSaver";
	const maxConcurrency = settings.parallelAgents;
	const coreWeight = isThroughput ? 5 : isTokenSaver ? 2 : 3;
	const reviewerWeight = isTokenSaver ? 2 : 1;
	const qaWeight = isTokenSaver ? 2 : 1;
	const backgroundWeight = 1;
	const reviewerMax = settings.reviewerLightMode ? 1 : 2;
	const qaMax = settings.qaLightMode ? 1 : 2;
	const coreMax = isTokenSaver ? math.max(1, maxConcurrency - 1) : maxConcurrency;

	const agentTeamsEnabled: Record<string, boolean> = {
		claude: settings.agentTeams?.claude?.enabled ?? true,
		codex: settings.agentTeams?.codex?.enabled ?? true,
		gemini: settings.agentTeams?.gemini?.enabled ?? true,
	};

	return {
		maxConcurrency,
		defaultTeamId: "core",
		orchestratorEnabled: settings.orchestratorEnabled ?? true,
		agentTeamsEnabled,
		laneWeights: {
			core: coreWeight,
			reviewer: reviewerWeight,
			qa: qaWeight,
			background: backgroundWeight,
		},
		teams: {
			core: {
				lane: "core",
				maxInFlight: coreMax,
				tokenMode: settings.useLightModel ? "light" : "standard",
				weight: coreWeight,
			},
			reviewer: {
				lane: "reviewer",
				maxInFlight: reviewerMax,
				tokenMode: settings.reviewerLightMode ? "light" : "standard",
				weight: reviewerWeight,
			},
			qa: {
				lane: "qa",
				maxInFlight: qaMax,
				tokenMode: settings.qaLightMode ? "light" : "standard",
				weight: qaWeight,
			},
			background: {
				lane: "background",
				maxInFlight: 1,
				tokenMode: settings.useLightModel ? "light" : "standard",
				weight: backgroundWeight,
			},
		},
		agentTeams: settings.agentTeams,
	};
}

function getPluginCapabilities(): Record<string, boolean> {
	const settings = State.getPluginSettings();
	return {
		pluginUiV2: true,
		multiConnectionTabs: true,
		activityTimeline: true,
		activityFeedOps: true,
		diagnosticsCockpit: true,
		structureMapExplorer: true,
		settingsPanel: true,
		scriptMetadataEndpoint: true,
		structureMapSummaryStatus: true,
		useLightModel: settings.useLightModel,
		useStructureMapping: settings.useStructureMapping,
		autoPortDiscovery: settings.autoPortDiscovery,
		verboseActivity: settings.verboseActivity,
		reviewerLightMode: settings.reviewerLightMode,
		qaLightMode: settings.qaLightMode,
		teamPresetBalanced: settings.teamPreset === "balanced",
		teamPresetThroughput: settings.teamPreset === "throughput",
		teamPresetTokenSaver: settings.teamPreset === "tokenSaver",
		orchestratorEnabled: settings.orchestratorEnabled ?? true,
		agentTeamClaude: settings.agentTeams?.claude?.enabled ?? true,
		agentTeamCodex: settings.agentTeams?.codex?.enabled ?? true,
		agentTeamGemini: settings.agentTeams?.gemini?.enabled ?? true,
	};
}

function getStudioMetadata() {
	return {
		placeId: game.PlaceId,
		placeName: game.Name,
		gameId: game.GameId,
	};
}

function extractPathFromRequestData(data: Record<string, unknown>): string | undefined {
	const candidates = [data.instancePath, data.path, data.parent, data.rootPath];
	for (const candidate of candidates) {
		if (typeIs(candidate, "string") && candidate.size() > 0) {
			return candidate;
		}
	}
	return undefined;
}

function buildRetryContext(endpoint: string, data: Record<string, unknown>): ActivityRetryContext {
	return {
		endpoint,
		path: extractPathFromRequestData(data),
		payload: data,
	};
}

function updateDiagnosticsFromServer(conn: Connection) {
	const now = tick();
	if (now - lastDiagnosticsPollAt < 2) {
		return;
	}
	lastDiagnosticsPollAt = now;

	task.spawn(() => {
		const [ok, result] = pcall(() => {
			return HttpService.RequestAsync({
				Url: `${conn.serverUrl}/diagnostics`,
				Method: "GET",
				Headers: { "Content-Type": "application/json" },
			});
		});
		if (!ok || !result.Success) {
			UI.updateDiagnosticsPanel({
				serverReachable: false,
				serverMessage: "diagnostics endpoint unreachable",
				bridgeStatus: "unreachable",
				pluginStatus: "unreachable",
				mcpStatus: "unreachable",
				endpointSupport: "unknown",
				cacheStatus: "unknown",
				writeQueueStatus: "unknown",
				lastErrorSummary: "none",
				lastErrorCause: "Cannot reach /diagnostics endpoint from plugin.",
				lastUpdatedAtText: "n/a",
			});
			return;
		}

		const [decodedOk, decoded] = pcall(() => HttpService.JSONDecode(result.Body) as DiagnosticsResponse);
		if (!decodedOk) {
			UI.updateDiagnosticsPanel({
				serverReachable: false,
				serverMessage: "invalid diagnostics payload",
				bridgeStatus: "invalid payload",
				pluginStatus: "invalid payload",
				mcpStatus: "invalid payload",
				endpointSupport: "unknown",
				cacheStatus: "unknown",
				writeQueueStatus: "unknown",
				lastErrorSummary: "invalid diagnostics response",
				lastErrorCause: "Server diagnostics JSON decode failed.",
				lastUpdatedAtText: "n/a",
			});
			return;
		}

		const diagnostics = decoded as DiagnosticsResponse;
		const pluginCaps = diagnostics.plugin?.capabilities ?? {};
		const serverCaps = diagnostics.serverCapabilities ?? {};
		const inFlight = diagnostics.writeQueue?.inFlight ? "active" : "idle";
		const pending = diagnostics.writeQueue?.pending ?? 0;
		const latestError = diagnostics.recentErrors && arrayCount(diagnostics.recentErrors) > 0
			? diagnostics.recentErrors[arrayCount(diagnostics.recentErrors) - 1]
			: undefined;
		const lastErrorSummary = latestError?.message ?? "none";
		const cache = diagnostics.runtime?.structureMap?.cache;
		const cacheStatus = cache
			? `structure:${cache.cached ? "ready" : "empty"} summaries:${tostring(cache.summaryCount ?? 0)} fresh:${tostring(cache.freshSummaryCount ?? 0)} stale:${tostring(cache.staleSummaryCount ?? 0)} source:${tostring(cache.sourceCount ?? 0)}`
			: "structure/source cache unavailable";

		UI.updateDiagnosticsPanel({
			serverReachable: true,
			serverMessage: "ok",
			bridgeStatus: diagnostics.bridge ? "online" : "unknown",
			pluginStatus: diagnostics.plugin?.connected ? "connected" : "not connected",
			mcpStatus: diagnostics.mcpServerActive ? "active" : "inactive",
			endpointSupport:
				`fastWrite:${tostring(serverCaps.setScriptSourceFast === true)} ` +
				`luauDiag:${tostring(serverCaps.luauDiagnostics === true)} ` +
				`fnEdit:${tostring(serverCaps.replaceScriptFunction === true)} ` +
				`logStream:${tostring(serverCaps.debugLogStreaming === true)} ` +
				`perfSnap:${tostring(serverCaps.capturePerformanceSnapshot === true)} ` +
				`scriptMetadata:${tostring(pluginCaps.scriptMetadata === true || pluginCaps.scriptMetadataEndpoint === true)} ` +
				`structureMap:${tostring(pluginCaps.useStructureMapping === true)}`,
			cacheStatus,
			writeQueueStatus: `${inFlight} / pending:${pending}`,
			lastErrorSummary,
			lastErrorCause: UI.inferProbableCause(lastErrorSummary),
			lastUpdatedAtText: DateTime.fromUnixTimestamp(math.floor(now)).FormatLocalTime("HH:mm:ss", "en-us"),
		});
	});
}

function retryFailedActivity(retryContext: ActivityRetryContext) {
	if (!retryContext.endpoint) {
		log("warn", "Retry skipped", "Missing endpoint in retry context.");
		return;
	}
	if (retryContext.endpoint === "/ready") {
		const conn = State.getActiveConnection();
		if (!conn) {
			log("warn", "Retry skipped", "No active connection for ready handshake retry.");
			return;
		}
		const handshakeOk = sendReadyHandshake(conn);
		if (handshakeOk) {
			log("success", "Retry completed", "Ready handshake sent.");
			updateDiagnosticsFromServer(conn);
		} else {
			log("error", "Retry failed", "Ready handshake failed again.", {
				endpoint: "/ready",
				error: "ready handshake failed",
				retryContext,
			});
		}
		return;
	}
	const request: RequestPayload = {
		endpoint: retryContext.endpoint,
		data: (retryContext.payload as Record<string, unknown> | undefined) ?? {},
	};
	const [ok, response] = pcall(() => processRequest(request));
	if (!ok) {
		log("error", "Retry failed", tostring(response), {
			endpoint: retryContext.endpoint,
			error: response,
			payload: retryContext.payload,
			path: retryContext.path,
			retryContext,
		});
		return;
	}

	if (typeIs(response, "table") && (response as Record<string, unknown>).error !== undefined) {
		log("error", "Retry returned error", tostring((response as Record<string, unknown>).error), {
			endpoint: retryContext.endpoint,
			error: (response as Record<string, unknown>).error,
			payload: retryContext.payload,
			path: retryContext.path,
			retryContext,
		});
		return;
	}

	log("success", "Retry completed", retryContext.endpoint, {
		endpoint: retryContext.endpoint,
		payload: retryContext.payload,
		path: retryContext.path,
	});
}

function normalizeDirectCommandEndpoint(endpoint: string): string {
	if (endpoint.sub(1, 1) === "/") {
		return endpoint;
	}
	return `/mcp/${endpoint}`;
}

function executeDirectCommand(taskId: string, endpoint: string, params: Record<string, unknown>) {
	const conn = State.getActiveConnection();
	if (!conn || !conn.isActive) {
		State.updateTask(taskId, {
			status: "failed",
			progress: 100,
			error: "No active MCP connection",
		});
		State.addLog("error", "plugin", `Direct command failed: no active connection for ${endpoint}`, taskId);
		return false;
	}

	const normalizedEndpoint = normalizeDirectCommandEndpoint(endpoint);
	task.spawn(() => {
		const [ok, result] = pcall(() => {
			return HttpService.RequestAsync({
				Url: `${conn.serverUrl}${normalizedEndpoint}`,
				Method: "POST",
				Headers: { "Content-Type": "application/json" },
				Body: HttpService.JSONEncode(params ?? {}),
			});
		});

		if (!ok || !result.Success) {
			const detail = ok ? `${result.StatusCode} ${result.StatusMessage}` : tostring(result);
			State.updateTask(taskId, {
				status: "failed",
				progress: 100,
				error: detail,
			});
			State.addLog("error", "bridge", `Direct command failed: ${normalizedEndpoint} (${detail})`, taskId);
			return;
		}

		let preview = result.Body;
		if (preview.size() > 220) {
			preview = `${preview.sub(1, 220)}...`;
		}
		State.updateTask(taskId, {
			status: "completed",
			progress: 100,
			result: preview,
		});
		State.addLog("info", "bridge", `Direct command completed: ${normalizedEndpoint}`, taskId);
		log("success", "Direct command completed", normalizedEndpoint, {
			endpoint: normalizedEndpoint,
			payload: params,
		});
	});
	return true;
}

function processRequest(request: RequestPayload): unknown {
	const endpoint = request.endpoint;
	const data = request.data ?? {};

	if (STRUCTURE_MAP_ENDPOINTS.has(endpoint) && !isStructureMapEnabled()) {
		return { error: "Structure map disabled in plugin settings" };
	}

	if (WRITE_ENDPOINTS.has(endpoint)) {
		const writeState = getStudioWriteState();
		if (shouldBlockWrite(writeState)) {
			return {
				error: describeWriteBlockReason(writeState) ?? "Write operation blocked.",
				writeState,
			};
		}
	}

	const handler = routeMap[endpoint];
	if (handler) {
		return handler(data as Record<string, unknown>);
	} else {
		return { error: `Unknown endpoint: ${endpoint}` };
	}
}

function sendResponse(conn: Connection, requestId: string, responseData: unknown) {
	const sessionId = State.getPluginSessionId();
	const [ok, result] = pcall(() => {
		return HttpService.RequestAsync({
			Url: `${conn.serverUrl}/response`,
			Method: "POST",
			Headers: {
				"Content-Type": "application/json",
				"x-mcp-session-id": sessionId,
			},
			Body: HttpService.JSONEncode({ requestId, response: responseData }),
		});
	});
	return ok && result.Success === true;
}

function getConnectionStatus(connIndex: number): string {
	const conn = State.getConnection(connIndex);
	if (!conn) return "disconnected";
	return deriveConnectionPhase(conn);
}

function pollForRequests(connIndex: number) {
	const conn = State.getConnection(connIndex);
	if (!conn || !conn.isActive) return;
	if (conn.isPolling) return;

	conn.isPolling = true;

	const [success, result] = pcall(() => {
		const sessionId = State.getPluginSessionId();
		const metadata = getStudioMetadata();
		return HttpService.RequestAsync({
			Url:
				`${conn.serverUrl}/poll?sid=${HttpService.UrlEncode(sessionId)}` +
				`&v=${HttpService.UrlEncode(State.CURRENT_VERSION)}` +
				`&placeId=${HttpService.UrlEncode(tostring(metadata.placeId))}` +
				`&placeName=${HttpService.UrlEncode(metadata.placeName)}` +
				`&gameId=${HttpService.UrlEncode(tostring(metadata.gameId))}`,
			Method: "GET",
			Headers: {
				"Content-Type": "application/json",
				"x-mcp-session-id": sessionId,
				"x-mcp-plugin-version": State.CURRENT_VERSION,
				"x-mcp-plugin-capabilities": HttpService.JSONEncode(getPluginCapabilities()),
				"x-mcp-place-id": tostring(metadata.placeId),
				"x-mcp-place-name": metadata.placeName,
				"x-mcp-game-id": tostring(metadata.gameId),
			},
		});
	});

	conn.isPolling = false;

	const ui = UI.getElements();
	UI.updateTabDot(connIndex);
	UI.updateUIState();

	if (success && isPollHttpSuccess(result)) {
		const [decodedOk, data] = pcall(() => HttpService.JSONDecode(result.Body) as PollResponse);
		if (!decodedOk) {
			conn.consecutiveFailures++;
			conn.lastHttpOk = false;
			conn.lastMcpConnected = false;
			log("error", "Polling payload invalid", "Server returned invalid JSON payload.", {
				error: data,
				retryContext: {
					endpoint: "/poll",
					payload: {
						serverUrl: conn.serverUrl,
						statusCode: result.StatusCode,
					},
				},
			});
			return;
		}

		conn.consecutiveFailures = 0;
		conn.currentRetryDelay = 0.5;
		conn.lastSuccessfulConnection = tick();

		const pollData = data as PollResponse;
		const mcpConnected = pollData.mcpConnected === true;
		const softWaitingStatus = typeIs(result.StatusCode, "number") && (result.StatusCode as number) === 503;
		conn.lastHttpOk = true;
		conn.lastMcpConnected = mcpConnected;

		if (connIndex === State.getActiveTabIndex()) {
			const el = ui;
			el.step1Dot.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
			el.step1Label.Text = "HTTP server (OK)";

			if (mcpConnected && !el.statusLabel.Text.find("Connected")[0]) {
				el.statusLabel.Text = "Connected";
				el.statusLabel.TextColor3 = Color3.fromRGB(34, 197, 94);
				el.statusIndicator.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
				el.statusPulse.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
				el.statusText.Text = "ONLINE";
				el.detailStatusLabel.Text = "HTTP: OK  MCP: OK";
				el.detailStatusLabel.TextColor3 = Color3.fromRGB(34, 197, 94);
				el.step2Dot.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
				el.step2Label.Text = "MCP bridge (OK)";
				el.step3Dot.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
				el.step3Label.Text = "Commands (OK)";
				conn.mcpWaitStartTime = undefined;
				el.troubleshootLabel.Visible = false;
				UI.stopPulseAnimation();
				log("success", "MCP connected", `Connected on port ${conn.port}`);
			} else if (!mcpConnected) {
				const mcpWaitStartedNow = conn.mcpWaitStartTime === undefined;
				el.statusLabel.Text = "Waiting for MCP server";
				el.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				el.statusIndicator.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.statusPulse.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.statusText.Text = "WAITING";
				el.detailStatusLabel.Text = "HTTP: OK  MCP: ...";
				el.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				el.step2Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step2Label.Text = "MCP bridge (waiting...)";
				el.step3Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step3Label.Text = "Commands (waiting...)";
				if (conn.mcpWaitStartTime === undefined) {
					conn.mcpWaitStartTime = tick();
				}
				const elapsed = tick() - (conn.mcpWaitStartTime ?? tick());
				if (softWaitingStatus && (mcpWaitStartedNow || elapsed % 5 < conn.pollInterval)) {
					log(
						"info",
						"MCP soft-wait",
						"HTTP 503 from /poll (server reachable, MCP not ready yet); continuing wait/retry.",
						{
							endpoint: "/poll",
							retryContext: {
								endpoint: "/poll",
								payload: {
									serverUrl: conn.serverUrl,
									statusCode: 503,
								},
							},
						},
					);
				}
				el.troubleshootLabel.Visible = elapsed > 8;
				if (elapsed > 3 && elapsed % 5 < conn.pollInterval) {
					task.spawn(() => {
						const discovered = discoverPort(conn);
						if (discovered !== undefined && discovered !== conn.port) {
							conn.port = discovered;
							conn.serverUrl = State.replaceConnectionPort(conn.serverUrl, discovered);
							if (connIndex === State.getActiveTabIndex()) {
								UI.getElements().urlInput.Text = conn.serverUrl;
							}
						}
					});
				}
				UI.startPulseAnimation();
			}
		}

		updateDiagnosticsFromServer(conn);

		if (pollData.tasks && arrayCount(pollData.tasks) > 0) {
			for (const taskUpdate of pollData.tasks) {
				if (taskUpdate.taskId && taskUpdate.status) {
					State.updateTask(taskUpdate.taskId, {
						status: taskUpdate.status as any,
						progress: taskUpdate.progress ?? State.getTask(taskUpdate.taskId)?.progress ?? 0,
					});
					State.addLog(
						taskUpdate.status === "completed" ? "info" :
						taskUpdate.status === "failed" ? "error" : "debug",
						"bridge",
						taskUpdate.message ?? `Task ${taskUpdate.taskId}: ${taskUpdate.status}`,
						taskUpdate.taskId
					);
				}
			}
		}

		if (pollData.request && mcpConnected) {
			const requestData = (pollData.request.data ?? {}) as Record<string, unknown>;
			const retryContext = buildRetryContext(pollData.request.endpoint, requestData);
			log("info", "MCP request received", pollData.request.endpoint, {
				endpoint: pollData.request.endpoint,
				payload: requestData,
				path: retryContext.path,
				retryContext,
			});
			task.spawn(() => {
				const [ok, response] = pcall(() => processRequest(pollData.request!));
				if (ok) {
					const responseSent = sendResponse(conn, pollData.requestId!, response);
					const responseHasError = typeIs(response, "table") && (response as Record<string, unknown>).error !== undefined;
					if (responseSent && !responseHasError) {
						log("success", "MCP response sent", pollData.request!.endpoint, {
							endpoint: pollData.request!.endpoint,
							payload: requestData,
							path: retryContext.path,
						});
					} else if (responseSent && responseHasError) {
						log("error", "MCP action returned error", tostring((response as Record<string, unknown>).error), {
							endpoint: pollData.request!.endpoint,
							error: (response as Record<string, unknown>).error,
							payload: requestData,
							path: retryContext.path,
							retryContext,
						});
					} else {
						log("error", "MCP response delivery failed", pollData.request!.endpoint, {
							endpoint: pollData.request!.endpoint,
							error: "response delivery failed",
							payload: requestData,
							path: retryContext.path,
						});
					}
				} else {
					const responseSent = sendResponse(conn, pollData.requestId!, { error: tostring(response) });
					if (!responseSent) {
						log("error", "MCP error delivery failed", tostring(response), {
							endpoint: pollData.request!.endpoint,
							error: response,
							payload: requestData,
							path: retryContext.path,
							retryContext,
						});
					}
					log("error", "MCP handler error", tostring(response), {
						endpoint: pollData.request!.endpoint,
						error: response,
						payload: requestData,
						path: retryContext.path,
						retryContext,
					});
				}
			});
		}
	} else if (conn.isActive) {
		const failureDetail = describePollFailure(success, result);
		conn.consecutiveFailures++;
		conn.lastHttpOk = false;
		conn.lastMcpConnected = false;
		if (conn.consecutiveFailures === 2 || conn.consecutiveFailures % 10 === 0) {
			log("warn", "Polling retry", `Attempt ${conn.consecutiveFailures} on port ${conn.port} (${failureDetail})`);
		}

		if (conn.consecutiveFailures > 1) {
			conn.currentRetryDelay = math.min(
				conn.currentRetryDelay * conn.retryBackoffMultiplier,
				conn.maxRetryDelay,
			);
		}

		if (conn.consecutiveFailures === 5 || conn.consecutiveFailures % 20 === 0) {
			task.spawn(() => {
				const discovered = discoverPort(conn);
				if (discovered !== undefined && discovered !== conn.port) {
					conn.port = discovered;
					conn.serverUrl = State.replaceConnectionPort(conn.serverUrl, discovered);
					conn.consecutiveFailures = 0;
					conn.currentRetryDelay = 0.5;
					if (connIndex === State.getActiveTabIndex()) {
						UI.getElements().urlInput.Text = conn.serverUrl;
					}
				}
			});
		}

		if (connIndex === State.getActiveTabIndex()) {
			const el = ui;
			if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) {
				el.statusLabel.Text = "Server unavailable";
				el.statusLabel.TextColor3 = Color3.fromRGB(239, 68, 68);
				el.statusIndicator.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
				el.statusPulse.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
				el.statusText.Text = "ERROR";
				el.detailStatusLabel.Text = "HTTP: X  MCP: X";
				el.detailStatusLabel.TextColor3 = Color3.fromRGB(239, 68, 68);
				el.step1Dot.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
				el.step1Label.Text = "HTTP server (error)";
				el.step2Dot.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
				el.step2Label.Text = "MCP bridge (error)";
				el.step3Dot.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
				el.step3Label.Text = "Commands (error)";
				conn.mcpWaitStartTime = undefined;
				el.troubleshootLabel.Visible = false;
				UI.stopPulseAnimation();
			} else if (conn.consecutiveFailures > 5) {
				const waitTime = math.ceil(conn.currentRetryDelay);
				el.statusLabel.Text = `Retrying (${waitTime}s)`;
				el.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				el.statusIndicator.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.statusPulse.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.statusText.Text = "RETRY";
				el.detailStatusLabel.Text = "HTTP: ...  MCP: ...";
				el.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				el.step1Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step1Label.Text = "HTTP server (retrying...)";
				el.step2Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step2Label.Text = "MCP bridge (retrying...)";
				el.step3Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step3Label.Text = "Commands (retrying...)";
				conn.mcpWaitStartTime = undefined;
				el.troubleshootLabel.Visible = false;
				UI.startPulseAnimation();
			} else if (conn.consecutiveFailures > 1) {
				el.statusLabel.Text = `Connecting (attempt ${conn.consecutiveFailures})`;
				el.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				el.statusIndicator.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.statusPulse.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.statusText.Text = "CONNECTING";
				el.detailStatusLabel.Text = "HTTP: ...  MCP: ...";
				el.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				el.step1Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step1Label.Text = "HTTP server (connecting...)";
				el.step2Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step2Label.Text = "MCP bridge (connecting...)";
				el.step3Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
				el.step3Label.Text = "Commands (connecting...)";
				conn.mcpWaitStartTime = undefined;
				el.troubleshootLabel.Visible = false;
				UI.startPulseAnimation();
			}
		}
	}
}

function discoverPort(conn?: Connection): number | undefined {
	if (!State.getPluginSettings().autoPortDiscovery) return undefined;
	const host = State.getServerHost(conn?.serverUrl ?? State.getActiveConnection().serverUrl);
	let firstActivePort: number | undefined;
	for (let offset = 0; offset < 5; offset++) {
		const port = State.BASE_PORT + offset;
		const [success, result] = pcall(() => {
			return HttpService.RequestAsync({
				Url: `http://${host}:${port}/status`,
				Method: "GET",
				Headers: { "Content-Type": "application/json" },
			});
		});

		if (success && result.Success) {
			const [ok, data] = pcall(() =>
				HttpService.JSONDecode(result.Body) as { mcpServerActive: boolean; pluginConnected: boolean },
			);
			if (ok && data.mcpServerActive) {
				// Prefer the port that already has a live plugin handshake.
				if (data.pluginConnected) return port;
				if (firstActivePort === undefined) firstActivePort = port;
			}
		}
	}
	return firstActivePort;
}

function sendReadyHandshake(conn: Connection): boolean {
	const settings = State.getPluginSettings();
	const sessionId = State.getPluginSessionId();
	const metadata = getStudioMetadata();
	const [ok, result] = pcall(() => {
		return HttpService.RequestAsync({
			Url: `${conn.serverUrl}/ready`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode({
				pluginReady: true,
				timestamp: tick(),
				version: State.CURRENT_VERSION,
				pluginInstanceId: sessionId,
				sessionId,
				serverUrl: conn.serverUrl,
				placeId: metadata.placeId,
				placeName: metadata.placeName,
				gameId: metadata.gameId,
				capabilities: getPluginCapabilities(),
				profile: {
					parallelAgents: settings.parallelAgents,
					useLightModel: settings.useLightModel,
					useStructureMapping: settings.useStructureMapping,
					teamPreset: settings.teamPreset,
					reviewerLightMode: settings.reviewerLightMode,
					qaLightMode: settings.qaLightMode,
					orchestratorEnabled: settings.orchestratorEnabled ?? true,
					agentTeams: settings.agentTeams,
					teamOrchestrator: buildTeamOrchestratorProfile(settings),
				},
			}),
		});
	});
	return ok && isHandshakeHttpSuccess(result);
}

function discoverAndApplyActivePort(): number | undefined {
	const idx = State.getActiveTabIndex();
	const conn = State.getConnection(idx);
	if (!conn) return undefined;
	const discovered = discoverPort(conn);
	if (discovered !== undefined && discovered !== conn.port) {
		conn.port = discovered;
		conn.serverUrl = State.replaceConnectionPort(conn.serverUrl, discovered);
		const el = UI.getElements();
		el.urlInput.Text = conn.serverUrl;
		log("success", "Port discovered", `Switched active connection to ${discovered}`);
		return discovered;
	}
	if (discovered === undefined) {
		log("warn", "Port discovery", "No active MCP endpoint found in scan range");
	} else {
		log("info", "Port discovery", `Already on best port ${discovered}`);
	}
	return discovered;
}

function refreshStructureMapFromQuickAction() {
	if (!isStructureMapEnabled()) {
		log("warn", "Structure map", "Feature disabled in settings", {
			endpoint: "/api/refresh-structure-map",
			category: "structure",
		});
		UI.refreshAgentMappingSection();
		UI.refreshStructureExplorerSection();
		return;
	}
	const [ok, result] = pcall(() => StructureMap.refreshStructureMap({}));
	if (ok) {
		const version = (result as Record<string, unknown>).version;
		log("success", "Structure map refreshed", `Version ${tostring(version)}`, {
			endpoint: "/api/refresh-structure-map",
			category: "structure",
		});
	} else {
		log("error", "Structure map refresh failed", tostring(result), {
			endpoint: "/api/refresh-structure-map",
			category: "error",
			error: result,
			retryContext: {
				endpoint: "/api/refresh-structure-map",
				payload: {},
			},
		});
	}
	UI.refreshAgentMappingSection();
	UI.refreshStructureExplorerSection();
}

function runBootstrapPing(connIndex: number, options: ActivationOptions) {
	if (!options.sendImmediatePing) {
		return;
	}

	task.spawn(() => {
		for (let attempt = 0; attempt < options.bootstrapRetryCount; attempt++) {
			const conn = State.getConnection(connIndex);
			if (!conn || !conn.isActive) {
				return;
			}

			const readyOk = sendReadyHandshake(conn);
			if (readyOk) {
				log("success", attempt === 0 ? "Ready handshake sent" : "Ready handshake retried", conn.serverUrl);
			} else if (attempt === options.bootstrapRetryCount - 1) {
				log("warn", "Ready handshake failed", conn.serverUrl);
			}

			pollForRequests(connIndex);
			updateDiagnosticsFromServer(conn);

			if (conn.lastMcpConnected) {
				return;
			}
			if (conn.lastHttpOk && !conn.lastMcpConnected && attempt < options.bootstrapRetryCount - 1) {
				log("info", "Ready handshake retry", "HTTP is up but MCP is not connected yet; retrying /ready");
			}
			if (attempt === options.bootstrapRetryCount - 1 && conn.lastHttpOk && !conn.lastMcpConnected) {
				log("warn", "Ready handshake timed out", "HTTP reachable but MCP still not connected.");
				return;
			}

			task.wait(options.bootstrapRetryDelaySeconds);
		}
	});
}

function activatePlugin(connIndex?: number, options?: ActivationOptions) {
	const idx = connIndex ?? State.getActiveTabIndex();
	const conn = State.getConnection(idx);
	if (!conn) return;

	const ui = UI.getElements();
	const activationOptions: ActivationOptions = options ?? {
		showUi: true,
		sendImmediatePing: true,
		bootstrapRetryCount: 1,
		bootstrapRetryDelaySeconds: 0.5,
	};
	const showUi = activationOptions.showUi;

	conn.isActive = true;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	conn.lastHttpOk = false;
	conn.lastMcpConnected = false;
	if (showUi) {
		ui.screenGui.Enabled = true;
	}

	if (idx === State.getActiveTabIndex()) {
		conn.serverUrl = ui.urlInput.Text;
		const [portStr] = conn.serverUrl.match(":(%d+)$");
		if (portStr) conn.port = tonumber(portStr) ?? conn.port;
		UI.updateUIState();
	}
	UI.updateTabDot(idx);
	log("info", "Connection activated", `Activating plugin on ${conn.serverUrl}`);

	task.spawn(() => {
		const discoveredPort = discoverPort(conn);
		if (discoveredPort !== undefined) {
			conn.port = discoveredPort;
			conn.serverUrl = State.replaceConnectionPort(conn.serverUrl, discoveredPort);
			if (idx === State.getActiveTabIndex()) {
				ui.urlInput.Text = conn.serverUrl;
			}
		}

		if (!conn.heartbeatConnection) {
			conn.heartbeatConnection = RunService.Heartbeat.Connect(() => {
				const now = tick();
				const currentInterval = conn.consecutiveFailures > 5 ? conn.currentRetryDelay : conn.pollInterval;
				if (now - conn.lastPoll > currentInterval) {
					conn.lastPoll = now;
					pollForRequests(idx);
				}
			});
		}

		runBootstrapPing(idx, activationOptions);
	});
}

function deactivatePlugin(connIndex?: number) {
	const idx = connIndex ?? State.getActiveTabIndex();
	const conn = State.getConnection(idx);
	if (!conn) return;

	conn.isActive = false;
	conn.lastHttpOk = false;
	conn.lastMcpConnected = false;
	log("info", "Connection deactivated", `Disconnected from ${conn.serverUrl}`);

	if (idx === State.getActiveTabIndex()) UI.updateUIState();
	UI.updateTabDot(idx);

	pcall(() => {
		const sessionId = State.getPluginSessionId();
		HttpService.RequestAsync({
			Url: `${conn.serverUrl}/disconnect`,
			Method: "POST",
			Headers: {
				"Content-Type": "application/json",
				"x-mcp-session-id": sessionId,
			},
			Body: HttpService.JSONEncode({ timestamp: tick(), sessionId }),
		});
	});

	if (conn.heartbeatConnection) {
		conn.heartbeatConnection.Disconnect();
		conn.heartbeatConnection = undefined;
	}

	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	UI.updateDiagnosticsPanel({
		serverReachable: false,
		serverMessage: "disconnected",
		bridgeStatus: "offline",
		pluginStatus: "disconnected",
		mcpStatus: "inactive",
		endpointSupport: "unknown",
		cacheStatus: "unknown",
		writeQueueStatus: "unknown",
		lastErrorSummary: "none",
		lastErrorCause: "Connect plugin to refresh diagnostics.",
		lastUpdatedAtText: DateTime.fromUnixTimestamp(math.floor(tick())).FormatLocalTime("HH:mm:ss", "en-us"),
	});
}

function deactivateAll() {
	for (let i = 0; i < arrayCount(State.getConnections()); i++) {
		if (State.getConnections()[i].isActive) {
			deactivatePlugin(i);
		}
	}
}

function checkForUpdates() {
	task.spawn(() => {
		const [success, result] = pcall(() => {
			return HttpService.RequestAsync({
				Url: "https://registry.npmjs.org/robloxstudio-mcp/latest",
				Method: "GET",
				Headers: { Accept: "application/json" },
			});
		});

		if (success && result.Success) {
			const [ok, data] = pcall(() => HttpService.JSONDecode(result.Body) as { version?: string });
			if (ok && data?.version) {
				const latestVersion = data.version;
				if (Utils.compareVersions(State.CURRENT_VERSION, latestVersion) < 0) {
					const ui = UI.getElements();
					ui.updateBannerText.Text = `v${latestVersion} available - github.com/boshyxd/robloxstudio-mcp`;
					ui.updateBanner.Visible = true;
					ui.contentFrame.Position = new UDim2(0, 8, 0, 92);
					ui.contentFrame.Size = new UDim2(1, -16, 1, -100);
				}
			}
		}
	});
}

export = {
	getConnectionStatus,
	activatePlugin,
	deactivatePlugin,
	deactivateAll,
	discoverAndApplyActivePort,
	refreshStructureMapFromQuickAction,
	sendReadyHandshakeForActive: () => {
		const conn = State.getActiveConnection();
		if (!conn) return false;
		const ok = sendReadyHandshake(conn);
		if (ok) {
			log("success", "Manual MCP sync", conn.serverUrl);
			updateDiagnosticsFromServer(conn);
		} else {
			log("error", "Manual MCP sync failed", conn.serverUrl, {
				error: "ready handshake failed",
				retryContext: {
					endpoint: "/ready",
					payload: {
						serverUrl: conn.serverUrl,
					},
				},
			});
		}
		return ok;
	},
	clearActivityFeed: () => {
		State.clearActivity();
		UI.pushActivity("info", "Activity feed", "Feed cleared");
	},
	checkForUpdates,
	retryFailedActivity,
	executeDirectCommand,
};
