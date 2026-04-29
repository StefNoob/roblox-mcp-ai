import { HttpService, RunService } from "@rbxts/services";
import State from "./State";
import Utils from "./Utils";
import UI from "./UI";
import QueryHandlers from "./handlers/QueryHandlers";
import PropertyHandlers from "./handlers/PropertyHandlers";
import InstanceHandlers from "./handlers/InstanceHandlers";
import ScriptHandlers from "./handlers/ScriptHandlers";
import MetadataHandlers from "./handlers/MetadataHandlers";
import TestHandlers from "./handlers/TestHandlers";
import StructureMap from "./StructureMap";
import { Connection, RequestPayload, PollResponse } from "../types";

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

	"/api/start-playtest": TestHandlers.startPlaytest,
	"/api/stop-playtest": TestHandlers.stopPlaytest,
	"/api/get-playtest-output": TestHandlers.getPlaytestOutput,
};

const STRUCTURE_MAP_ENDPOINTS = new Set<string>([
	"/api/structure-map-summary",
	"/api/query-structure-map",
	"/api/script-inventory",
	"/api/refresh-structure-map",
]);

function log(level: "info" | "success" | "warn" | "error", title: string, detail: string, endpoint?: string) {
	UI.pushActivity(level, title, detail, endpoint);
}

function isStructureMapEnabled(): boolean {
	return State.getPluginSettings().useStructureMapping;
}

function getPluginCapabilities(): Record<string, boolean> {
	const settings = State.getPluginSettings();
	return {
		pluginUiV2: true,
		multiConnectionTabs: true,
		activityTimeline: true,
		settingsPanel: true,
		useLightModel: settings.useLightModel,
		useStructureMapping: settings.useStructureMapping,
		autoPortDiscovery: settings.autoPortDiscovery,
		verboseActivity: settings.verboseActivity,
	};
}

function processRequest(request: RequestPayload): unknown {
	const endpoint = request.endpoint;
	const data = request.data ?? {};

	if (STRUCTURE_MAP_ENDPOINTS.has(endpoint) && !isStructureMapEnabled()) {
		return { error: "Structure map disabled in plugin settings" };
	}

	const handler = routeMap[endpoint];
	if (handler) {
		return handler(data as Record<string, unknown>);
	} else {
		return { error: `Unknown endpoint: ${endpoint}` };
	}
}

function sendResponse(conn: Connection, requestId: string, responseData: unknown) {
	pcall(() => {
		HttpService.RequestAsync({
			Url: `${conn.serverUrl}/response`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode({ requestId, response: responseData }),
		});
	});
}

function getConnectionStatus(connIndex: number): string {
	const conn = State.getConnection(connIndex);
	if (!conn || !conn.isActive) return "disconnected";
	if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) return "error";
	if (conn.lastHttpOk) return "connected";
	return "connecting";
}

function pollForRequests(connIndex: number) {
	const conn = State.getConnection(connIndex);
	if (!conn || !conn.isActive) return;
	if (conn.isPolling) return;

	conn.isPolling = true;

	const [success, result] = pcall(() => {
		const capsJson = HttpService.JSONEncode(getPluginCapabilities());
		const capsEncoded = HttpService.UrlEncode(capsJson);
		const pollUrl = `${conn.serverUrl}/poll?v=${State.CURRENT_VERSION}&sid=studio-plugin&caps=${capsEncoded}`;
		return HttpService.RequestAsync({
			Url: pollUrl,
			Method: "GET",
			Headers: {
				"Content-Type": "application/json",
				"x-mcp-plugin-version": State.CURRENT_VERSION,
				"x-mcp-plugin-capabilities": capsJson,
			},
		});
	});

	conn.isPolling = false;

	const ui = UI.getElements();
	UI.updateTabDot(connIndex);

	if (success && (result.Success || result.StatusCode === 503)) {
		conn.consecutiveFailures = 0;
		conn.currentRetryDelay = 0.5;
		conn.lastSuccessfulConnection = tick();

		const data = HttpService.JSONDecode(result.Body) as PollResponse;
		const mcpConnected = data.mcpConnected === true;
		conn.lastHttpOk = true;

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
				el.troubleshootLabel.Visible = elapsed > 8;
				if (elapsed > 3 && elapsed % 5 < conn.pollInterval) {
					task.spawn(() => {
						const discovered = discoverPort();
						if (discovered !== undefined && discovered !== conn.port) {
							conn.port = discovered;
							conn.serverUrl = `http://localhost:${discovered}`;
							if (connIndex === State.getActiveTabIndex()) {
								UI.getElements().urlInput.Text = conn.serverUrl;
							}
						}
					});
				}
				UI.startPulseAnimation();
			}
		}

		if (data.request && mcpConnected) {
			log("info", "MCP request received", data.request.endpoint, data.request.endpoint);
			task.spawn(() => {
				const [ok, response] = pcall(() => processRequest(data.request!));
				if (ok) {
					sendResponse(conn, data.requestId!, response);
					log("success", "MCP response sent", data.request!.endpoint, data.request!.endpoint);
				} else {
					sendResponse(conn, data.requestId!, { error: tostring(response) });
					log("error", "MCP handler error", tostring(response), data.request!.endpoint);
				}
			});
		}
	} else if (conn.isActive) {
		conn.consecutiveFailures++;
		if (conn.consecutiveFailures === 2 || conn.consecutiveFailures % 10 === 0) {
			log("warn", "Polling retry", `Attempt ${conn.consecutiveFailures} on port ${conn.port}`);
		}

		if (conn.consecutiveFailures > 1) {
			conn.currentRetryDelay = math.min(
				conn.currentRetryDelay * conn.retryBackoffMultiplier,
				conn.maxRetryDelay,
			);
		}

		if (conn.consecutiveFailures === 5 || conn.consecutiveFailures % 20 === 0) {
			task.spawn(() => {
				const discovered = discoverPort();
				if (discovered !== undefined && discovered !== conn.port) {
					conn.port = discovered;
					conn.serverUrl = `http://localhost:${discovered}`;
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

function discoverPort(): number | undefined {
	if (!State.getPluginSettings().autoPortDiscovery) return undefined;
	let firstActivePort: number | undefined;
	for (let offset = 0; offset < 5; offset++) {
		const port = State.BASE_PORT + offset;
		const [success, result] = pcall(() => {
			return HttpService.RequestAsync({
				Url: `http://localhost:${port}/status`,
				Method: "GET",
				Headers: { "Content-Type": "application/json" },
			});
		});

		if (success && result.Success) {
			const [ok, data] = pcall(() =>
				HttpService.JSONDecode(result.Body) as { mcpServerActive: boolean; pluginConnected: boolean },
			);
			if (ok && data.mcpServerActive) {
				if (!data.pluginConnected) return port;
				if (firstActivePort === undefined) firstActivePort = port;
			}
		}
	}
	return firstActivePort;
}

function sendReadyHandshake(conn: Connection): boolean {
	const settings = State.getPluginSettings();
	const [ok] = pcall(() => {
		HttpService.RequestAsync({
			Url: `${conn.serverUrl}/ready`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode({
				pluginReady: true,
				timestamp: tick(),
				version: State.CURRENT_VERSION,
				pluginInstanceId: "studio-plugin",
				capabilities: getPluginCapabilities(),
				profile: {
					parallelAgents: settings.parallelAgents,
					useLightModel: settings.useLightModel,
					useStructureMapping: settings.useStructureMapping,
				},
			}),
		});
	});
	return ok;
}

function discoverAndApplyActivePort(): number | undefined {
	const idx = State.getActiveTabIndex();
	const conn = State.getConnection(idx);
	if (!conn) return undefined;
	const discovered = discoverPort();
	if (discovered !== undefined && discovered !== conn.port) {
		conn.port = discovered;
		conn.serverUrl = `http://localhost:${discovered}`;
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
		log("warn", "Structure map", "Feature disabled in settings");
		return;
	}
	const [ok, result] = pcall(() => StructureMap.refreshStructureMap({}));
	if (ok) {
		const version = (result as Record<string, unknown>).version;
		log("success", "Structure map refreshed", `Version ${tostring(version)}`);
	} else {
		log("error", "Structure map refresh failed", tostring(result));
	}
}

function activatePlugin(connIndex?: number) {
	const idx = connIndex ?? State.getActiveTabIndex();
	const conn = State.getConnection(idx);
	if (!conn) return;

	const ui = UI.getElements();

	conn.isActive = true;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	ui.screenGui.Enabled = true;

	if (idx === State.getActiveTabIndex()) {
		conn.serverUrl = ui.urlInput.Text;
		const [portStr] = conn.serverUrl.match(":(%d+)$");
		if (portStr) conn.port = tonumber(portStr) ?? conn.port;
		UI.updateUIState();
	}
	UI.updateTabDot(idx);
	log("info", "Connection activated", `Activating plugin on ${conn.serverUrl}`);

	task.spawn(() => {
		const discoveredPort = discoverPort();
		if (discoveredPort !== undefined) {
			conn.port = discoveredPort;
			conn.serverUrl = `http://localhost:${discoveredPort}`;
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

		const readyOk = sendReadyHandshake(conn);
		if (readyOk) {
			log("success", "Ready handshake sent", conn.serverUrl);
		} else {
			log("warn", "Ready handshake failed", conn.serverUrl);
		}
	});
}

function deactivatePlugin(connIndex?: number) {
	const idx = connIndex ?? State.getActiveTabIndex();
	const conn = State.getConnection(idx);
	if (!conn) return;

	conn.isActive = false;
	log("info", "Connection deactivated", `Disconnected from ${conn.serverUrl}`);

	if (idx === State.getActiveTabIndex()) UI.updateUIState();
	UI.updateTabDot(idx);

	pcall(() => {
		HttpService.RequestAsync({
			Url: `${conn.serverUrl}/disconnect`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode({ timestamp: tick() }),
		});
	});

	if (conn.heartbeatConnection) {
		conn.heartbeatConnection.Disconnect();
		conn.heartbeatConnection = undefined;
	}

	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
}

function deactivateAll() {
	for (let i = 0; i < State.getConnections().size(); i++) {
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
		} else {
			log("error", "Manual MCP sync failed", conn.serverUrl);
		}
		return ok;
	},
	clearActivityFeed: () => {
		State.clearActivity();
		UI.pushActivity("info", "Activity feed", "Feed cleared");
	},
	checkForUpdates,
};
