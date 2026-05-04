import { HttpService, TweenService } from "@rbxts/services";
import State from "./State";
import StructureMap from "./StructureMap";
import { deriveConnectionPhase } from "./ConnectionStatus";
import {
	ActivityCategory,
	ActivityEntry,
	ActivityLevel,
	ActivityRetryContext,
	AgentTeamConfig,
	Connection,
	PluginSettings,
	TaskPhase,
	ActiveTask,
	StepRecord,
	ArtifactRecord,
} from "../types";
import type { AgentMappingSnapshot } from "./MappingSummary";

interface UIElements {
	screenGui: DockWidgetPluginGui;
	mainFrame: Frame;
	contentFrame: ScrollingFrame;
	statusLabel: TextLabel;
	detailStatusLabel: TextLabel;
	statusIndicator: Frame;
	statusPulse: Frame;
	statusText: TextLabel;
	connectButton: TextButton;
	connectStroke: UIStroke;
	urlInput: TextBox;
	step1Dot: Frame;
	step1Label: TextLabel;
	step2Dot: Frame;
	step2Label: TextLabel;
	step3Dot: Frame;
	step3Label: TextLabel;
	troubleshootLabel: TextLabel;
	updateBanner: Frame;
	updateBannerText: TextLabel;
	tabBar: Frame;
}

interface TabButton {
	frame: Frame;
	label: TextLabel;
	dot: Frame;
}

interface QuickActionHandlers {
	onRefreshStructureMap?: () => void;
	onDiscoverPort?: () => void;
	onSendReadyHandshake?: () => void;
	onClearActivity?: () => void;
	onRetryFailedActivity?: (retryContext: ActivityRetryContext) => void;
	onExecuteDirectCommand?: (taskId: string, endpoint: string, params: Record<string, unknown>) => void;
}

type SettingsChangedHandler = (settings: PluginSettings) => void;
type ViewName = "overview" | "activity" | "agents" | "mission" | "chat" | "settings" | "commands" | "tasks" | "log";

interface ActivityPushOptions {
	endpoint?: string;
	category?: ActivityCategory;
	path?: string;
	payload?: unknown;
	error?: unknown;
	groupKey?: string;
	retryContext?: ActivityRetryContext;
}

interface ActivityFilterState {
	read: boolean;
	write: boolean;
	error: boolean;
	structure: boolean;
}

interface DiagnosticsSnapshot {
	serverReachable: boolean;
	serverMessage: string;
	bridgeStatus: string;
	pluginStatus: string;
	mcpStatus: string;
	endpointSupport: string;
	cacheStatus: string;
	writeQueueStatus: string;
	lastErrorSummary: string;
	lastErrorCause: string;
	lastUpdatedAtText: string;
}

const SETTINGS_KEY = "mcp_plugin_settings_v2";
const TWEEN_QUICK = new TweenInfo(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const CORNER = new UDim(0, 6);
const StudioService = game.GetService("StudioService");

const C = {
	bg: Color3.fromRGB(10, 15, 26),
	card: Color3.fromRGB(16, 24, 40),
	surface: Color3.fromRGB(22, 34, 58),
	surfaceAlt: Color3.fromRGB(13, 20, 34),
	border: Color3.fromRGB(35, 52, 80),
	subtle: Color3.fromRGB(60, 82, 120),
	muted: Color3.fromRGB(133, 156, 197),
	label: Color3.fromRGB(230, 238, 255),
	green: Color3.fromRGB(52, 211, 153),
	yellow: Color3.fromRGB(251, 191, 36),
	red: Color3.fromRGB(248, 113, 113),
	gray: Color3.fromRGB(105, 124, 158),
	blue: Color3.fromRGB(96, 165, 250),
};

let elements: UIElements = undefined!;
let pulseAnimation: Tween | undefined;
let buttonHover = false;
let activeView: ViewName = "overview";
let quickActionHandlers: QuickActionHandlers = {};
let onSettingsChanged: SettingsChangedHandler | undefined;
let pluginInstance: Plugin | undefined;

let tabButtons: Map<number, TabButton> = new Map();
const viewButtons = new Map<ViewName, TextButton>();
const viewPanels = new Map<ViewName, Frame>();
const activityRows = new Map<number, Frame>();
const activityFilters: ActivityFilterState = {
	read: true,
	write: true,
	error: true,
	structure: true,
};
let activityGroupedByPath = true;
let logFilters: { debug: boolean; info: boolean; warn: boolean; error: boolean } = {
	debug: false,
	info: true,
	warn: true,
	error: true,
};
let settingsSummaryLabel: TextLabel | undefined;
let agentMappingHeadlineLabel: TextLabel | undefined;
let agentMappingMetaLabel: TextLabel | undefined;
let agentMappingContextLabel: TextLabel | undefined;
let agentMappingRootsLabel: TextLabel | undefined;
let agentMappingSubsystemsLabel: TextLabel | undefined;
let agentMappingScriptsLabel: TextLabel | undefined;
let activityFilterReadBtn: TextButton | undefined;
let activityFilterWriteBtn: TextButton | undefined;
let activityFilterErrorBtn: TextButton | undefined;
let activityFilterStructureBtn: TextButton | undefined;
let activityGroupBtn: TextButton | undefined;
let diagnosticsBridgeLabel: TextLabel | undefined;
let diagnosticsPluginLabel: TextLabel | undefined;
let diagnosticsMcpLabel: TextLabel | undefined;
let diagnosticsEndpointSupportLabel: TextLabel | undefined;
let diagnosticsCacheLabel: TextLabel | undefined;
let diagnosticsWriteQueueLabel: TextLabel | undefined;
let diagnosticsErrorLabel: TextLabel | undefined;
let diagnosticsCauseLabel: TextLabel | undefined;
let diagnosticsUpdatedLabel: TextLabel | undefined;
let diagnosticsLastSnapshot: DiagnosticsSnapshot | undefined;
let explorerSubsystemInput: TextBox | undefined;
let explorerScriptTypeInput: TextBox | undefined;
let explorerPathPrefixInput: TextBox | undefined;
let explorerSummaryStatusInput: TextBox | undefined;
let explorerResultList: Frame | undefined;
let agentStatusSummaryLabel: TextLabel | undefined;
let agentMetricsLabel: TextLabel | undefined;
let agentThreadsLabel: TextLabel | undefined;
let chatMessagesList: ScrollingFrame | undefined;
let chatInputBox: TextBox | undefined;
let missionGoalLabel: TextLabel | undefined;
let missionPhaseLabel: TextLabel | undefined;
let missionProgressLabel: TextLabel | undefined;
let missionReasonLabel: TextLabel | undefined;
let missionActionLabel: TextLabel | undefined;
let missionPanel: Frame | undefined;
let stepTimelineList: Frame | undefined;
let artifactList: Frame | undefined;
let teamSelectCards: Map<string, Frame> = new Map();
let orchestratorModeLabel: TextLabel | undefined;
let tasksPanel: Frame | undefined;
let tasksList: ScrollingFrame | undefined;
let taskRows: Map<string, Frame> = new Map();
let logPanel: Frame | undefined;
let logList: ScrollingFrame | undefined;
let logRows: Map<number, Frame> = new Map();
let commandsPanel: Frame | undefined;
let commandsList: ScrollingFrame | undefined;
let settingsControls: {
	parallelValue?: TextLabel;
	teamPresetButton?: TextButton;
	lightToggle?: TextButton;
	reviewerLightToggle?: TextButton;
	qaLightToggle?: TextButton;
	mappingToggle?: TextButton;
	autoPortToggle?: TextButton;
	verboseToggle?: TextButton;
	orchestratorToggle?: TextButton;
	claudeToggle?: TextButton;
	codexToggle?: TextButton;
	geminiToggle?: TextButton;
} = {};

let refreshTabBar: () => void = () => {};
let switchToTab: (index: number) => void = () => {};

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

function tweenProp(instance: Instance, props: Record<string, unknown>) {
	TweenService.Create(instance, TWEEN_QUICK, props as unknown as { [key: string]: unknown }).Play();
}

function getStatusDotColor(connIndex: number): Color3 {
	const conn = State.getConnection(connIndex);
	if (!conn) return C.red;

	const phase = deriveConnectionPhase(conn);
	if (phase === "connected") return C.green;
	if (phase === "disconnected" || phase === "error") return C.red;
	return C.yellow;
}

function setButtonConnect(btn: TextButton, stroke: UIStroke) {
	btn.Text = "Connect";
	btn.TextColor3 = C.label;
	btn.BackgroundColor3 = C.surface;
	stroke.Color = C.subtle;
}

function setButtonDisconnect(btn: TextButton, stroke: UIStroke) {
	btn.Text = "Disconnect";
	btn.TextColor3 = C.red;
	btn.BackgroundColor3 = C.surfaceAlt;
	stroke.Color = Color3.fromRGB(110, 50, 50);
}

function stopPulseAnimation() {
	elements.statusPulse.Size = new UDim2(0, 12, 0, 12);
	elements.statusPulse.Position = new UDim2(0, -2, 0, -2);
	elements.statusPulse.BackgroundTransparency = 0.7;
	if (pulseAnimation) {
		pulseAnimation.Cancel();
	}
}

function startPulseAnimation() {
	if (pulseAnimation) {
		pulseAnimation.Cancel();
	}
	elements.statusPulse.Size = new UDim2(0, 12, 0, 12);
	elements.statusPulse.Position = new UDim2(0, -2, 0, -2);
	elements.statusPulse.BackgroundTransparency = 0.7;
	pulseAnimation = TweenService.Create(
		elements.statusPulse,
		new TweenInfo(0.9, Enum.EasingStyle.Quad, Enum.EasingDirection.Out, -1),
		{
			Size: new UDim2(0, 20, 0, 20),
			Position: new UDim2(0, -6, 0, -6),
			BackgroundTransparency: 1,
		},
	);
	pulseAnimation.Play();
}

function createTextButton(parent: Instance, text: string, size: UDim2, order?: number): TextButton {
	const btn = new Instance("TextButton");
	btn.Size = size;
	btn.BackgroundColor3 = C.surface;
	btn.BorderSizePixel = 0;
	btn.Text = text;
	btn.TextColor3 = C.label;
	btn.TextSize = 10;
	btn.Font = Enum.Font.GothamSemibold;
	if (order !== undefined) btn.LayoutOrder = order;
	btn.Parent = parent;

	const corner = new Instance("UICorner");
	corner.CornerRadius = CORNER;
	corner.Parent = btn;

	const stroke = new Instance("UIStroke");
	stroke.Color = C.border;
	stroke.Thickness = 1;
	stroke.Parent = btn;

	btn.MouseEnter.Connect(() => tweenProp(btn, { BackgroundColor3: C.subtle }));
	btn.MouseLeave.Connect(() => tweenProp(btn, { BackgroundColor3: C.surface }));
	return btn;
}

function saveSettings(settings: PluginSettings) {
	if (!pluginInstance) return;
	pcall(() => {
		pluginInstance!.SetSetting(SETTINGS_KEY, settings as unknown as object);
	});
}

function loadSettings(): PluginSettings {
	const defaults = State.getDefaultSettings();
	if (!pluginInstance) return defaults;

	const [ok, value] = pcall(() => pluginInstance!.GetSetting(SETTINGS_KEY));
	if (!ok || !value || !typeIs(value, "table")) {
		return defaults;
	}

	const raw = value as unknown as Partial<PluginSettings>;
	const agentTeamsDefaults = defaults.agentTeams;
	const loadedTeams = raw.agentTeams;
	const agentTeams: Record<string, AgentTeamConfig> = {
		claude: loadedTeams?.claude ? { ...agentTeamsDefaults.claude, ...loadedTeams.claude } : agentTeamsDefaults.claude,
		codex: loadedTeams?.codex ? { ...agentTeamsDefaults.codex, ...loadedTeams.codex } : agentTeamsDefaults.codex,
		gemini: loadedTeams?.gemini ? { ...agentTeamsDefaults.gemini, ...loadedTeams.gemini } : agentTeamsDefaults.gemini,
	};
	return {
		parallelAgents: math.clamp(tonumber(raw.parallelAgents) ?? defaults.parallelAgents, 1, 4),
		useLightModel: raw.useLightModel === true,
		useStructureMapping: raw.useStructureMapping !== false,
		autoPortDiscovery: raw.autoPortDiscovery !== false,
		verboseActivity: raw.verboseActivity !== false,
		teamPreset:
			raw.teamPreset === "throughput" || raw.teamPreset === "tokenSaver"
				? raw.teamPreset
				: defaults.teamPreset,
		reviewerLightMode: raw.reviewerLightMode !== false,
		qaLightMode: raw.qaLightMode !== false,
		orchestratorEnabled: raw.orchestratorEnabled !== false,
		agentTeams,
	};
}

function formatTeamPresetLabel(preset: PluginSettings["teamPreset"]): string {
	if (preset === "throughput") return "Throughput";
	if (preset === "tokenSaver") return "Token Saver";
	return "Balanced";
}

function applySettingsUI(settings: PluginSettings) {
	if (settingsControls.parallelValue) {
		settingsControls.parallelValue.Text = tostring(settings.parallelAgents);
	}
	if (settingsControls.teamPresetButton) {
		settingsControls.teamPresetButton.Text = formatTeamPresetLabel(settings.teamPreset);
		settingsControls.teamPresetButton.TextColor3 = settings.teamPreset === "tokenSaver" ? C.green : C.label;
	}
	if (settingsControls.lightToggle) {
		settingsControls.lightToggle.Text = settings.useLightModel ? "ON" : "OFF";
		settingsControls.lightToggle.TextColor3 = settings.useLightModel ? C.green : C.muted;
	}
	if (settingsControls.reviewerLightToggle) {
		settingsControls.reviewerLightToggle.Text = settings.reviewerLightMode ? "ON" : "OFF";
		settingsControls.reviewerLightToggle.TextColor3 = settings.reviewerLightMode ? C.green : C.muted;
	}
	if (settingsControls.qaLightToggle) {
		settingsControls.qaLightToggle.Text = settings.qaLightMode ? "ON" : "OFF";
		settingsControls.qaLightToggle.TextColor3 = settings.qaLightMode ? C.green : C.muted;
	}
	if (settingsControls.mappingToggle) {
		settingsControls.mappingToggle.Text = settings.useStructureMapping ? "ON" : "OFF";
		settingsControls.mappingToggle.TextColor3 = settings.useStructureMapping ? C.green : C.muted;
	}
	if (settingsControls.autoPortToggle) {
		settingsControls.autoPortToggle.Text = settings.autoPortDiscovery ? "ON" : "OFF";
		settingsControls.autoPortToggle.TextColor3 = settings.autoPortDiscovery ? C.green : C.muted;
	}
	if (settingsControls.verboseToggle) {
		settingsControls.verboseToggle.Text = settings.verboseActivity ? "ON" : "OFF";
		settingsControls.verboseToggle.TextColor3 = settings.verboseActivity ? C.green : C.muted;
	}
	if (settingsControls.orchestratorToggle) {
		settingsControls.orchestratorToggle.Text = settings.orchestratorEnabled ? "ON" : "OFF";
		settingsControls.orchestratorToggle.TextColor3 = settings.orchestratorEnabled ? C.green : C.muted;
	}
	if (settingsControls.claudeToggle && settings.agentTeams?.claude) {
		settingsControls.claudeToggle.Text = settings.agentTeams.claude.enabled ? "ON" : "OFF";
		settingsControls.claudeToggle.TextColor3 = settings.agentTeams.claude.enabled ? C.green : C.muted;
	}
	if (settingsControls.codexToggle && settings.agentTeams?.codex) {
		settingsControls.codexToggle.Text = settings.agentTeams.codex.enabled ? "ON" : "OFF";
		settingsControls.codexToggle.TextColor3 = settings.agentTeams.codex.enabled ? C.green : C.muted;
	}
	if (settingsControls.geminiToggle && settings.agentTeams?.gemini) {
		settingsControls.geminiToggle.Text = settings.agentTeams.gemini.enabled ? "ON" : "OFF";
		settingsControls.geminiToggle.TextColor3 = settings.agentTeams.gemini.enabled ? C.green : C.muted;
	}
	if (settingsSummaryLabel) {
		settingsSummaryLabel.Text =
			`Agents ${settings.parallelAgents} | ` +
			`Preset ${formatTeamPresetLabel(settings.teamPreset)} | ` +
			`Orchestrator ${settings.orchestratorEnabled ? "ON" : "OFF"}`;
	}
}

function commitSettings(patch: Partial<PluginSettings>) {
	const updated = State.updatePluginSettings(patch);
	applySettingsUI(updated);
	saveSettings(updated);
	if (onSettingsChanged) {
		onSettingsChanged(updated);
	}
}

function formatTime(t: number): string {
	const date = DateTime.fromUnixTimestamp(math.floor(t));
	return date.FormatLocalTime("HH:mm:ss", "en-us");
}

function levelColor(level: ActivityLevel): Color3 {
	if (level === "success") return C.green;
	if (level === "warn") return C.yellow;
	if (level === "error") return C.red;
	return C.blue;
}

function phaseColor(phase: TaskPhase): Color3 {
	if (phase === "planning") return C.blue;
	if (phase === "building") return C.green;
	if (phase === "testing") return C.yellow;
	if (phase === "reviewing") return C.muted;
	if (phase === "done") return C.green;
	if (phase === "error") return C.red;
	return C.gray;
}

function phaseLabel(phase: TaskPhase): string {
	if (phase === "idle") return "Idle";
	if (phase === "planning") return "Planning";
	if (phase === "building") return "Building";
	if (phase === "testing") return "Testing";
	if (phase === "reviewing") return "Reviewing";
	if (phase === "done") return "Done";
	if (phase === "error") return "Error";
	return phase;
}

function inferActivityCategory(level: ActivityLevel, endpoint?: string): ActivityCategory {
	if (level === "error") {
		return "error";
	}
	if (
		endpoint &&
		(
			endpoint.find("structure-map")[0] !== undefined ||
			endpoint.find("script-inventory")[0] !== undefined ||
			endpoint.find("project-structure")[0] !== undefined
		)
	) {
		return "structure";
	}
	if (
		endpoint &&
		(
			endpoint.find("/set-")[0] !== undefined ||
			endpoint.find("/edit-")[0] !== undefined ||
			endpoint.find("/insert-")[0] !== undefined ||
			endpoint.find("/delete-")[0] !== undefined ||
			endpoint.find("/create-")[0] !== undefined ||
			endpoint.find("/add-")[0] !== undefined ||
			endpoint.find("/remove-")[0] !== undefined
		)
	) {
		return "write";
	}
	if (endpoint !== undefined) {
		return "read";
	}
	return "system";
}

function toActivityOptions(options?: string | ActivityPushOptions): ActivityPushOptions {
	if (typeIs(options, "string")) {
		return { endpoint: options };
	}
	return options ?? {};
}

function stringifyPayload(payload: unknown): string | undefined {
	if (payload === undefined) {
		return undefined;
	}
	const [ok, encoded] = pcall(() => HttpService.JSONEncode(payload as defined));
	if (ok && typeIs(encoded, "string")) {
		return encoded as string;
	}
	return tostring(payload);
}

function extractPathFromPayload(payload: unknown): string | undefined {
	if (!payload || !typeIs(payload, "table")) {
		return undefined;
	}
	const data = payload as Record<string, unknown>;
	const candidates = [
		data.instancePath,
		data.path,
		data.parent,
		data.rootPath,
	];
	for (const candidate of candidates) {
		if (typeIs(candidate, "string") && candidate.size() > 0) {
			return candidate;
		}
	}
	return undefined;
}

function isActivityVisibleByFilter(item: ActivityEntry): boolean {
	if (item.category === "write") return activityFilters.write;
	if (item.category === "error") return activityFilters.error;
	if (item.category === "structure") return activityFilters.structure;
	return activityFilters.read;
}

function updateActivityFilterButtons() {
	if (activityFilterReadBtn) {
		activityFilterReadBtn.Text = `Reads ${activityFilters.read ? "ON" : "OFF"}`;
		activityFilterReadBtn.TextColor3 = activityFilters.read ? C.green : C.muted;
	}
	if (activityFilterWriteBtn) {
		activityFilterWriteBtn.Text = `Writes ${activityFilters.write ? "ON" : "OFF"}`;
		activityFilterWriteBtn.TextColor3 = activityFilters.write ? C.green : C.muted;
	}
	if (activityFilterErrorBtn) {
		activityFilterErrorBtn.Text = `Errors ${activityFilters.error ? "ON" : "OFF"}`;
		activityFilterErrorBtn.TextColor3 = activityFilters.error ? C.green : C.muted;
	}
	if (activityFilterStructureBtn) {
		activityFilterStructureBtn.Text = `Structure ${activityFilters.structure ? "ON" : "OFF"}`;
		activityFilterStructureBtn.TextColor3 = activityFilters.structure ? C.green : C.muted;
	}
	if (activityGroupBtn) {
		activityGroupBtn.Text = activityGroupedByPath ? "Group: path" : "Group: timeline";
		activityGroupBtn.TextColor3 = activityGroupedByPath ? C.green : C.muted;
	}
}

function copyToClipboard(text: string): boolean {
	if (!text || text.size() === 0) {
		return false;
	}
	const [ok] = pcall(() => {
		(StudioService as unknown as { CopyToClipboard: (value: string) => void }).CopyToClipboard(text);
	});
	return ok;
}

function inferProbableCause(errorText: string): string {
	const lowered = errorText.lower();
	if (lowered.find("timeout")[0] !== undefined) {
		return "Likely network timeout between plugin and MCP bridge.";
	}
	if (lowered.find("stale")[0] !== undefined || lowered.find("heartbeat")[0] !== undefined) {
		return "Likely stale plugin heartbeat; reconnect plugin or restart Studio.";
	}
	if (lowered.find("not connected")[0] !== undefined || lowered.find("unavailable")[0] !== undefined) {
		return "Likely bridge/server disconnected; verify MCP server process and port.";
	}
	if (lowered.find("unknown endpoint")[0] !== undefined) {
		return "Likely plugin/server version mismatch (missing endpoint support).";
	}
	if (lowered.find("write operation blocked")[0] !== undefined || lowered.find("play mode")[0] !== undefined) {
		return "Likely Studio write safety guard (play mode or read-only state).";
	}
	return "Inspect payload and endpoint details for the failing action.";
}

function copyActivityData(item: ActivityEntry): boolean {
	const payload = item.payloadText;
	const errorText = item.errorText;
	const text = errorText ?? payload ?? `${item.title}\n${item.detail}`;
	return copyToClipboard(text);
}

type ActivityRenderGroup = {
	key: string;
	items: ActivityEntry[];
};

function rebuildActivityRows() {
	const panel = viewPanels.get("activity");
	if (!panel) return;

	const list = panel.FindFirstChild("ActivityList") as Frame | undefined;
	if (!list) return;

	activityRows.forEach((row) => row.Destroy());
	activityRows.clear();

	const allItems = State.getActivity();
	const filtered: ActivityEntry[] = [];
	for (const item of allItems) {
		if (isActivityVisibleByFilter(item)) {
			filtered.push(item);
		}
	}

	if (arrayCount(filtered) === 0) {
		const emptyLabel = new Instance("TextLabel");
		emptyLabel.Name = "EmptyLabel";
		emptyLabel.Size = new UDim2(1, 0, 0, 22);
		emptyLabel.BackgroundTransparency = 1;
		emptyLabel.Text = "No activity for the current filters.";
		emptyLabel.TextColor3 = C.muted;
		emptyLabel.TextSize = 10;
		emptyLabel.Font = Enum.Font.GothamMedium;
		emptyLabel.TextXAlignment = Enum.TextXAlignment.Left;
		emptyLabel.Parent = list;
		activityRows.set(-1, emptyLabel as unknown as Frame);
		return;
	}

	const groups: ActivityRenderGroup[] = [];
	if (!activityGroupedByPath) {
		for (const item of filtered) {
			groups.push({ key: tostring(item.id), items: [item] });
		}
	} else {
		const order: string[] = [];
		const buckets = new Map<string, ActivityEntry[]>();
		for (const item of filtered) {
			const key = item.groupKey ?? item.path ?? item.endpoint ?? item.title;
			if (!buckets.has(key)) {
				buckets.set(key, []);
				order.push(key);
			}
			buckets.get(key)!.push(item);
		}
		for (const key of order) {
			const bucket = buckets.get(key);
			if (!bucket || arrayCount(bucket) === 0) continue;
			groups.push({ key, items: bucket });
		}
	}

	let layoutOrder = 0;
	for (const group of groups) {
		layoutOrder += 1;
		const item = group.items[0];
		const groupedCount = arrayCount(group.items);
		const canRetry = item.retryContext !== undefined;
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 50);
		row.BackgroundColor3 = C.surfaceAlt;
		row.BorderSizePixel = 0;
		row.LayoutOrder = layoutOrder;
		row.Parent = list;

		const corner = new Instance("UICorner");
		corner.CornerRadius = CORNER;
		corner.Parent = row;

		const dot = new Instance("Frame");
		dot.Size = new UDim2(0, 6, 0, 6);
		dot.Position = new UDim2(0, 8, 0, 8);
		dot.BackgroundColor3 = levelColor(item.level);
		dot.BorderSizePixel = 0;
		dot.Parent = row;

		const dotCorner = new Instance("UICorner");
		dotCorner.CornerRadius = new UDim(1, 0);
		dotCorner.Parent = dot;

		const title = new Instance("TextLabel");
		title.Size = new UDim2(1, -156, 0, 16);
		title.Position = new UDim2(0, 20, 0, 2);
		title.BackgroundTransparency = 1;
		title.Text = groupedCount > 1 ? `${item.title} (${groupedCount})` : item.title;
		title.TextColor3 = C.label;
		title.TextSize = 10;
		title.Font = Enum.Font.GothamSemibold;
		title.TextXAlignment = Enum.TextXAlignment.Left;
		title.TextTruncate = Enum.TextTruncate.AtEnd;
		title.Parent = row;

		const detail = new Instance("TextLabel");
		detail.Size = new UDim2(1, -156, 0, 16);
		detail.Position = new UDim2(0, 20, 0, 18);
		detail.BackgroundTransparency = 1;
		detail.Text = activityGroupedByPath
			? `${item.path ?? item.endpoint ?? group.key} | ${item.detail}`
			: item.detail;
		detail.TextColor3 = C.muted;
		detail.TextSize = 9;
		detail.Font = Enum.Font.GothamMedium;
		detail.TextXAlignment = Enum.TextXAlignment.Left;
		detail.TextTruncate = Enum.TextTruncate.AtEnd;
		detail.Parent = row;

		const stamp = new Instance("TextLabel");
		stamp.Size = new UDim2(0, 68, 0, 14);
		stamp.Position = new UDim2(1, -72, 0, 2);
		stamp.BackgroundTransparency = 1;
		stamp.Text = formatTime(item.timestamp);
		stamp.TextColor3 = C.muted;
		stamp.TextSize = 8;
		stamp.Font = Enum.Font.GothamMedium;
		stamp.TextXAlignment = Enum.TextXAlignment.Right;
		stamp.Parent = row;

		const copyBtn = createTextButton(row, "Copy", new UDim2(0, 44, 0, 18));
		copyBtn.Position = new UDim2(1, -94, 0, 24);
		copyBtn.TextSize = 8;
		copyBtn.Activated.Connect(() => {
			const copied = copyActivityData(item);
			if (copied) {
				pushActivity("success", "Copied activity payload", `Copied data for ${item.title}`);
			} else {
				pushActivity("warn", "Copy failed", "Clipboard write is unavailable in this Studio context.");
			}
		});

		if (canRetry) {
			const retryBtn = createTextButton(row, "Retry", new UDim2(0, 44, 0, 18));
			retryBtn.Position = new UDim2(1, -46, 0, 24);
			retryBtn.TextSize = 8;
			retryBtn.Activated.Connect(() => {
				const retryContext = item.retryContext;
				if (!retryContext || !quickActionHandlers.onRetryFailedActivity) {
					pushActivity("warn", "Retry unavailable", "No retry handler is available for this activity.");
					return;
				}
				quickActionHandlers.onRetryFailedActivity(retryContext);
			});
		}

		activityRows.set(item.id, row);
	}
}

function setActiveView(view: ViewName) {
	activeView = view;
	for (const [k, panel] of viewPanels) {
		panel.Visible = k === view;
	}
	for (const [k, btn] of viewButtons) {
		const active = k === view;
		btn.BackgroundColor3 = active ? C.subtle : C.surface;
		btn.TextColor3 = active ? C.label : C.muted;
	}
	if (view === "activity") {
		rebuildActivityRows();
	}
	if (view === "overview") {
		refreshAgentMappingSection();
		rebuildStructureExplorerList();
	}
	if (view === "agents") {
		rebuildAgentStatusPanel();
	}
	if (view === "mission") {
		refreshMissionPanel();
	}
	if (view === "chat") {
		rebuildChatMessages();
	}
	if (view === "settings") {
		refreshAgentMappingSection();
	}
}

function refreshMissionPanel() {
	const goalLbl = missionGoalLabel;
	const phaseLbl = missionPhaseLabel;
	const progressLbl = missionProgressLabel;
	const reasonLbl = missionReasonLabel;
	const actionLbl = missionActionLabel;
	const orchLbl = orchestratorModeLabel;
	if (!goalLbl || !phaseLbl || !progressLbl || !reasonLbl || !actionLbl || !orchLbl) return;

	const task = State.getActiveTask();
	const steps = State.getStepHistory();
	const artifacts = State.getArtifactRegistry();
	const team = State.getTeamContext();

	goalLbl.Text = task.goal !== "" ? task.goal : "No active mission";
	phaseLbl.Text = `Phase: ${phaseLabel(task.phase)}`;
	phaseLbl.TextColor3 = phaseColor(task.phase);
	progressLbl.Text = task.stepTotal > 0 ? `Step ${task.stepIndex}/${task.stepTotal}` : `Step ${task.stepIndex}/?`;
	reasonLbl.Text = task.reason;
	actionLbl.Text = task.nextSuggestedAction !== "" ? `Next: ${task.nextSuggestedAction}` : "";

	const fillBar = missionPanel?.FindFirstChild("PhaseBarFill") as Frame;
	if (fillBar) {
		const progress = task.stepTotal > 0 ? task.stepIndex / task.stepTotal : 0;
		fillBar.Size = new UDim2(progress, 0, 1, 0);
		fillBar.BackgroundColor3 = phaseColor(task.phase);
	}

	if (orchLbl) {
		orchLbl.Text = team.orchestratorMode;
	}

	if (stepTimelineList) {
		for (const child of stepTimelineList.GetChildren()) {
			if (child.IsA("Frame")) {
				child.Destroy();
			}
		}
		for (const step of steps) {
			const stepRow = new Instance("Frame");
			stepRow.Size = new UDim2(1, 0, 0, 20);
			stepRow.BackgroundTransparency = 1;
			stepRow.Parent = stepTimelineList;

			const dot = new Instance("Frame");
			dot.Size = new UDim2(0, 6, 0, 6);
			dot.Position = new UDim2(0, 4, 0.5, -3);
			dot.BackgroundColor3 = phaseColor(step.phase);
			dot.BorderSizePixel = 0;
			dot.Parent = stepRow;

			const dotCorner = new Instance("UICorner");
			dotCorner.CornerRadius = new UDim(1, 0);
			dotCorner.Parent = dot;

			const title = new Instance("TextLabel");
			title.Size = new UDim2(0.6, 0, 1, 0);
			title.Position = new UDim2(0, 14, 0, 0);
			title.BackgroundTransparency = 1;
			title.Text = step.title;
			title.TextColor3 = C.label;
			title.TextSize = 8;
			title.Font = Enum.Font.GothamMedium;
			title.TextXAlignment = Enum.TextXAlignment.Left;
			title.TextTruncate = Enum.TextTruncate.AtEnd;
			title.Parent = stepRow;

			const status = new Instance("TextLabel");
			status.Size = new UDim2(0.4, 0, 1, 0);
			status.Position = new UDim2(0.6, 0, 0, 0);
			status.BackgroundTransparency = 1;
			status.Text = step.status;
			status.TextColor3 = step.status === "completed" ? C.green : step.status === "failed" ? C.red : C.muted;
			status.TextSize = 8;
			status.Font = Enum.Font.GothamMedium;
			status.TextXAlignment = Enum.TextXAlignment.Right;
			status.Parent = stepRow;
		}
		if (steps.size() === 0) {
			const emptyLabel = new Instance("TextLabel");
			emptyLabel.Size = new UDim2(1, 0, 0, 16);
			emptyLabel.BackgroundTransparency = 1;
			emptyLabel.Text = "No steps yet";
			emptyLabel.TextColor3 = C.muted;
			emptyLabel.TextSize = 8;
			emptyLabel.Font = Enum.Font.GothamMedium;
			emptyLabel.TextXAlignment = Enum.TextXAlignment.Left;
			emptyLabel.Parent = stepTimelineList;
		}
	}

	for (const [teamType, card] of teamSelectCards) {
		const isSelected = team.selectedAgents.find((a) => a === teamType) !== undefined;
		const stroke = card.FindFirstChild("CardStroke") as UIStroke;
		if (stroke) {
			stroke.Color = isSelected ? agentTeamColors[teamType] ?? C.green : C.border;
			stroke.Thickness = isSelected ? 2 : 1;
		}
		const selectBtn = card.FindFirstChild(teamType + "Select") as TextButton;
		if (selectBtn) {
			selectBtn.Text = isSelected ? "Selected" : "Select";
			selectBtn.TextColor3 = isSelected ? C.green : C.muted;
		}
		const statusLbl = card.FindFirstChild(teamType + "Status") as TextLabel;
		if (statusLbl) {
			const isActive = team.activeAgents.find((a) => a === teamType) !== undefined;
			statusLbl.Text = isActive ? "active" : "idle";
			statusLbl.TextColor3 = isActive ? C.green : C.muted;
		}
	}

	State.setOnActiveTaskChanged((task) => {
		if (missionGoalLabel) missionGoalLabel.Text = task.goal !== "" ? task.goal : "No active mission";
		if (missionPhaseLabel) {
			missionPhaseLabel.Text = `Phase: ${phaseLabel(task.phase)}`;
			missionPhaseLabel.TextColor3 = phaseColor(task.phase);
		}
		if (missionProgressLabel) {
			missionProgressLabel.Text = task.stepTotal > 0 ? `Step ${task.stepIndex}/${task.stepTotal}` : `Step ${task.stepIndex}/?`;
		}
		if (missionReasonLabel) missionReasonLabel.Text = task.reason;
		if (missionActionLabel) missionActionLabel.Text = task.nextSuggestedAction !== "" ? `Next: ${task.nextSuggestedAction}` : "";
	});

	State.setOnTeamContextChanged((ctx) => {
		if (orchestratorModeLabel) orchestratorModeLabel.Text = ctx.orchestratorMode;
		for (const [teamType, card] of teamSelectCards) {
			const isSelected = ctx.selectedAgents.find((a) => a === teamType) !== undefined;
			const stroke = card.FindFirstChild("CardStroke") as UIStroke;
			if (stroke) {
				stroke.Color = isSelected ? agentTeamColors[teamType] ?? C.green : C.border;
				stroke.Thickness = isSelected ? 2 : 1;
			}
		}
	});
}

function createRowLabel(parent: Instance, text: string): TextLabel {
	const label = new Instance("TextLabel");
	label.Size = new UDim2(1, 0, 0, 12);
	label.BackgroundTransparency = 1;
	label.Text = text;
	label.TextColor3 = C.muted;
	label.TextSize = 9;
	label.Font = Enum.Font.GothamMedium;
	label.TextXAlignment = Enum.TextXAlignment.Left;
	label.Parent = parent;
	return label;
}

function formatMappingList(
	prefix: string,
	items: string[],
	emptyText: string,
	limit: number,
	totalCount?: number,
): string {
	if (arrayCount(items) === 0) {
		return `${prefix}: ${emptyText}`;
	}
	const limited: string[] = [];
	for (let index = 0; index < math.min(arrayCount(items), limit); index++) {
		limited.push(items[index]);
	}
	const effectiveTotal = totalCount ?? arrayCount(items);
	const suffix = effectiveTotal > limit ? ` +${effectiveTotal - limit} more` : "";
	return `${prefix}: ${limited.join(", ")}${suffix}`;
}

function applyAgentMappingSnapshot(snapshot: AgentMappingSnapshot) {
	if (!agentMappingHeadlineLabel || !agentMappingMetaLabel || !agentMappingContextLabel) {
		return;
	}

	agentMappingHeadlineLabel.Text = snapshot.headline;
	agentMappingMetaLabel.Text = snapshot.meta;
	agentMappingContextLabel.Text = snapshot.context;
	if (agentMappingRootsLabel) {
		agentMappingRootsLabel.Text = formatMappingList("Roots", snapshot.roots, "No roots mapped yet", 4, snapshot.rootTotal);
	}
	if (agentMappingSubsystemsLabel) {
		agentMappingSubsystemsLabel.Text = formatMappingList(
			"Subsystems",
			snapshot.subsystems,
			"No subsystems inferred yet",
			4,
			snapshot.subsystemTotal,
		);
	}
	if (agentMappingScriptsLabel) {
		agentMappingScriptsLabel.Text = formatMappingList("Scripts", snapshot.scripts, "No scripts indexed yet", 4, snapshot.scriptTotal);
	}
}

function refreshAgentMappingSection() {
	if (!agentMappingHeadlineLabel || !agentMappingMetaLabel || !agentMappingContextLabel) {
		return;
	}

	const settings = State.getPluginSettings();
	if (!settings.useStructureMapping) {
		agentMappingHeadlineLabel.Text = "Mapping disabled";
		agentMappingMetaLabel.Text = "Turn on structure mapping in Settings to expose plugin map data.";
		agentMappingContextLabel.Text = "The agent only receives live map details from the plugin when mapping is enabled.";
		if (agentMappingRootsLabel) agentMappingRootsLabel.Text = "Roots: Not available";
		if (agentMappingSubsystemsLabel) agentMappingSubsystemsLabel.Text = "Subsystems: Not available";
		if (agentMappingScriptsLabel) agentMappingScriptsLabel.Text = "Scripts: Not available";
		return;
	}

	applyAgentMappingSnapshot(StructureMap.getAgentMappingSnapshot({ autoBuild: false }));
}

function updateDiagnosticsPanel(snapshot: DiagnosticsSnapshot) {
	diagnosticsLastSnapshot = snapshot;
	if (diagnosticsBridgeLabel) diagnosticsBridgeLabel.Text = `Bridge: ${snapshot.bridgeStatus}`;
	if (diagnosticsPluginLabel) diagnosticsPluginLabel.Text = `Plugin: ${snapshot.pluginStatus}`;
	if (diagnosticsMcpLabel) diagnosticsMcpLabel.Text = `MCP: ${snapshot.mcpStatus}`;
	if (diagnosticsEndpointSupportLabel) diagnosticsEndpointSupportLabel.Text = `Endpoints: ${snapshot.endpointSupport}`;
	if (diagnosticsCacheLabel) diagnosticsCacheLabel.Text = `Cache: ${snapshot.cacheStatus}`;
	if (diagnosticsWriteQueueLabel) diagnosticsWriteQueueLabel.Text = `Write queue: ${snapshot.writeQueueStatus}`;
	if (diagnosticsErrorLabel) diagnosticsErrorLabel.Text = `Last error: ${snapshot.lastErrorSummary}`;
	if (diagnosticsCauseLabel) diagnosticsCauseLabel.Text = `Cause: ${snapshot.lastErrorCause}`;
	if (diagnosticsUpdatedLabel) diagnosticsUpdatedLabel.Text = `Updated: ${snapshot.lastUpdatedAtText}`;
}

function createCompactLabel(parent: Instance, textSize: number = 9, textColor: Color3 = C.muted): TextLabel {
	const label = new Instance("TextLabel");
	label.Size = new UDim2(1, 0, 0, 14);
	label.BackgroundTransparency = 1;
	label.Text = "";
	label.TextWrapped = true;
	label.TextColor3 = textColor;
	label.TextSize = textSize;
	label.Font = Enum.Font.GothamMedium;
	label.TextXAlignment = Enum.TextXAlignment.Left;
	label.TextYAlignment = Enum.TextYAlignment.Top;
	label.Parent = parent;
	return label;
}

function rebuildStructureExplorerList() {
	if (!explorerResultList) return;

	const list = explorerResultList;
	for (const child of list.GetChildren()) {
		if (child.IsA("GuiObject") && child.Name !== "Layout") {
			child.Destroy();
		}
	}

	const settings = State.getPluginSettings();
	if (!settings.useStructureMapping) {
		const label = createCompactLabel(list, 9, C.yellow);
		label.Name = "ExplorerDisabled";
		label.Text = "Structure map disabled in Settings.";
		return;
	}

	const subsystemRaw = explorerSubsystemInput?.Text ?? "";
	const scriptTypeRaw = explorerScriptTypeInput?.Text ?? "";
	const pathPrefixRaw = explorerPathPrefixInput?.Text ?? "";
	const summaryStatusRaw = explorerSummaryStatusInput?.Text.lower() ?? "";

	let summaryStatus: "missing" | "fresh" | "stale" | undefined = undefined;
	if (summaryStatusRaw === "missing" || summaryStatusRaw === "fresh" || summaryStatusRaw === "stale") {
		summaryStatus = summaryStatusRaw;
	}

	const response = StructureMap.queryStructureMap({
		autoBuild: false,
		mode: "standard",
		filters: {
			limit: 60,
			hasSource: true,
			subsystem: subsystemRaw.size() > 0 ? subsystemRaw : undefined,
			scriptType: scriptTypeRaw.size() > 0 ? scriptTypeRaw : undefined,
			pathPrefix: pathPrefixRaw.size() > 0 ? pathPrefixRaw : undefined,
			summaryStatus,
		},
	}) as {
		count?: number;
		nodes?: Array<{ path?: string; scriptType?: string; summaryStatus?: string; subsystem?: string }>;
		pendingBuild?: boolean;
	};

	const nodes = response.nodes ?? [];
	if (response.pendingBuild) {
		const label = createCompactLabel(list, 9, C.yellow);
		label.Text = "Structure map idle. Use Refresh Structure Map to build this view.";
		return;
	}
	if (arrayCount(nodes) === 0) {
		const label = createCompactLabel(list, 9, C.muted);
		label.Text = "No script matches for current filters.";
		return;
	}

	for (const node of nodes) {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 30);
		row.BackgroundTransparency = 1;
		row.Parent = list;

		const top = new Instance("TextLabel");
		top.Size = new UDim2(1, 0, 0, 14);
		top.BackgroundTransparency = 1;
		top.Text = node.path ?? "unknown path";
		top.TextColor3 = C.label;
		top.TextSize = 9;
		top.Font = Enum.Font.GothamMedium;
		top.TextXAlignment = Enum.TextXAlignment.Left;
		top.TextTruncate = Enum.TextTruncate.AtEnd;
		top.Parent = row;

		const meta = new Instance("TextLabel");
		meta.Size = new UDim2(1, 0, 0, 14);
		meta.Position = new UDim2(0, 0, 0, 14);
		meta.BackgroundTransparency = 1;
		meta.Text = `${node.scriptType ?? "Script"} | ${node.subsystem ?? "Unknown"} | summary ${(node.summaryStatus ?? "missing").upper()}`;
		meta.TextColor3 = C.muted;
		meta.TextSize = 8;
		meta.Font = Enum.Font.GothamMedium;
		meta.TextXAlignment = Enum.TextXAlignment.Left;
		meta.TextTruncate = Enum.TextTruncate.AtEnd;
		meta.Parent = row;
	}
}

function createTabButton(connIndex: number) {
	const conn = State.getConnection(connIndex);
	if (!conn) return;

	const isActive = connIndex === State.getActiveTabIndex();
	const tabFrame = new Instance("Frame");
	tabFrame.Size = new UDim2(0, 70, 1, -6);
	tabFrame.Position = new UDim2(0, 0, 0, 3);
	tabFrame.BackgroundColor3 = isActive ? C.surface : C.surfaceAlt;
	tabFrame.BackgroundTransparency = isActive ? 0 : 0.25;
	tabFrame.BorderSizePixel = 0;
	tabFrame.LayoutOrder = connIndex;
	tabFrame.Parent = elements.tabBar;

	const corner = new Instance("UICorner");
	corner.CornerRadius = CORNER;
	corner.Parent = tabFrame;

	const dot = new Instance("Frame");
	dot.Size = new UDim2(0, 5, 0, 5);
	dot.Position = new UDim2(0, 8, 0.5, -2);
	dot.BackgroundColor3 = getStatusDotColor(connIndex);
	dot.BorderSizePixel = 0;
	dot.Parent = tabFrame;

	const dotCorner = new Instance("UICorner");
	dotCorner.CornerRadius = new UDim(1, 0);
	dotCorner.Parent = dot;

	const label = new Instance("TextLabel");
	label.Size = new UDim2(1, -14, 1, 0);
	label.Position = new UDim2(0, 14, 0, 0);
	label.BackgroundTransparency = 1;
	label.Text = tostring(conn.port);
	label.TextColor3 = isActive ? C.label : C.muted;
	label.TextSize = 9;
	label.Font = Enum.Font.GothamMedium;
	label.TextXAlignment = Enum.TextXAlignment.Left;
	label.TextTruncate = Enum.TextTruncate.AtEnd;
	label.Parent = tabFrame;

	const hit = new Instance("TextButton");
	hit.Size = new UDim2(1, 0, 1, 0);
	hit.BackgroundTransparency = 1;
	hit.Text = "";
	hit.Parent = tabFrame;
	hit.Activated.Connect(() => switchToTab(connIndex));

	tabButtons.set(connIndex, { frame: tabFrame, label, dot });
}

refreshTabBar = () => {
	tabButtons.forEach((tb) => tb.frame.Destroy());
	tabButtons = new Map();
	for (let i = 0; i < arrayCount(State.getConnections()); i++) {
		createTabButton(i);
	}
};

switchToTab = (index: number) => {
	if (index < 0 || index >= arrayCount(State.getConnections())) return;
	State.setActiveTabIndex(index);
	const conn = State.getActiveConnection();
	elements.urlInput.Text = conn.serverUrl;

	tabButtons.forEach((tb, i) => {
		const active = i === index;
		tb.frame.BackgroundColor3 = active ? C.surface : C.surfaceAlt;
		tb.frame.BackgroundTransparency = active ? 0 : 0.25;
		tb.label.TextColor3 = active ? C.label : C.muted;
	});

	updateUIState();
};

function pushActivity(
	level: ActivityLevel,
	title: string,
	detail: string,
	options?: string | ActivityPushOptions,
) {
	const settings = State.getPluginSettings();
	if (!settings.verboseActivity && level === "info") {
		return;
	}
	const normalized = toActivityOptions(options);
	const payloadText = stringifyPayload(normalized.payload);
	const errorText = normalized.error !== undefined ? tostring(normalized.error) : undefined;
	const path = normalized.path ?? extractPathFromPayload(normalized.payload);
	const category = normalized.category ?? inferActivityCategory(level, normalized.endpoint);
	const item = State.addActivity(level, category, title, detail, {
		endpoint: normalized.endpoint,
		path,
		payloadText,
		errorText,
		groupKey: normalized.groupKey ?? path ?? normalized.endpoint ?? title,
		retryContext: normalized.retryContext,
	});

	if (activeView === "activity") {
		rebuildActivityRows();
	}
}

function init(pluginRef: Plugin) {
	pluginInstance = pluginRef;
	const CURRENT_VERSION = State.CURRENT_VERSION;
	const loadedSettings = loadSettings();
	State.setPluginSettings(loadedSettings);

	const screenGui = pluginRef.CreateDockWidgetPluginGuiAsync(
		"MCPServerInterface",
		new DockWidgetPluginGuiInfo(Enum.InitialDockState.Float, false, false, 420, 560, 320, 300),
	);
	(screenGui as unknown as { Title: string }).Title = `MCP Agent Cockpit v${CURRENT_VERSION}`;

	const mainFrame = new Instance("Frame");
	mainFrame.Size = new UDim2(1, 0, 1, 0);
	mainFrame.BackgroundColor3 = C.bg;
	mainFrame.BorderSizePixel = 0;
	mainFrame.Parent = screenGui;

	const header = new Instance("Frame");
	header.Size = new UDim2(1, 0, 0, 46);
	header.BackgroundColor3 = C.bg;
	header.BorderSizePixel = 0;
	header.Parent = mainFrame;

	const titleLabel = new Instance("TextLabel");
	titleLabel.Size = new UDim2(1, -40, 0, 20);
	titleLabel.Position = new UDim2(0, 10, 0, 4);
	titleLabel.BackgroundTransparency = 1;
	titleLabel.Text = `MCP Agent Cockpit v${CURRENT_VERSION}`;
	titleLabel.TextColor3 = C.label;
	titleLabel.TextSize = 12;
	titleLabel.Font = Enum.Font.GothamBold;
	titleLabel.TextXAlignment = Enum.TextXAlignment.Left;
	titleLabel.Parent = header;

	const statusContainer = new Instance("Frame");
	statusContainer.Size = new UDim2(0, 20, 0, 20);
	statusContainer.Position = new UDim2(1, -26, 0, 8);
	statusContainer.BackgroundTransparency = 1;
	statusContainer.Parent = header;

	const statusIndicator = new Instance("Frame");
	statusIndicator.Size = new UDim2(0, 8, 0, 8);
	statusIndicator.Position = new UDim2(0.5, -4, 0.5, -4);
	statusIndicator.BackgroundColor3 = C.red;
	statusIndicator.BorderSizePixel = 0;
	statusIndicator.Parent = statusContainer;

	const statusCorner = new Instance("UICorner");
	statusCorner.CornerRadius = new UDim(1, 0);
	statusCorner.Parent = statusIndicator;

	const statusPulse = new Instance("Frame");
	statusPulse.Size = new UDim2(0, 12, 0, 12);
	statusPulse.Position = new UDim2(0, -2, 0, -2);
	statusPulse.BackgroundColor3 = C.red;
	statusPulse.BackgroundTransparency = 0.7;
	statusPulse.BorderSizePixel = 0;
	statusPulse.Parent = statusIndicator;

	const pulseCorner = new Instance("UICorner");
	pulseCorner.CornerRadius = new UDim(1, 0);
	pulseCorner.Parent = statusPulse;

	const statusText = new Instance("TextLabel");
	statusText.Size = new UDim2(0, 0, 0, 0);
	statusText.BackgroundTransparency = 1;
	statusText.Text = "OFFLINE";
	statusText.TextTransparency = 1;
	statusText.TextSize = 1;
	statusText.Font = Enum.Font.GothamMedium;
	statusText.TextColor3 = C.label;
	statusText.Parent = statusContainer;

	const subtitle = new Instance("TextLabel");
	subtitle.Size = new UDim2(1, -20, 0, 14);
	subtitle.Position = new UDim2(0, 10, 0, 24);
	subtitle.BackgroundTransparency = 1;
	subtitle.Text = "Operational UI for MCP requests, status and agent settings";
	subtitle.TextColor3 = C.muted;
	subtitle.TextSize = 8;
	subtitle.Font = Enum.Font.GothamMedium;
	subtitle.TextXAlignment = Enum.TextXAlignment.Left;
	subtitle.Parent = header;

	const tabBar = new Instance("Frame");
	tabBar.Size = new UDim2(1, 0, 0, 24);
	tabBar.Position = new UDim2(0, 0, 0, 46);
	tabBar.BackgroundColor3 = C.bg;
	tabBar.BorderSizePixel = 0;
	tabBar.Parent = mainFrame;

	const tabLayout = new Instance("UIListLayout");
	tabLayout.FillDirection = Enum.FillDirection.Horizontal;
	tabLayout.Padding = new UDim(0, 4);
	tabLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	tabLayout.VerticalAlignment = Enum.VerticalAlignment.Center;
	tabLayout.Parent = tabBar;

	const tabPadding = new Instance("UIPadding");
	tabPadding.PaddingLeft = new UDim(0, 10);
	tabPadding.PaddingRight = new UDim(0, 10);
	tabPadding.Parent = tabBar;

	const addTabBtn = createTextButton(tabBar, "+", new UDim2(0, 20, 0, 20), 999);
	addTabBtn.Activated.Connect(() => {
		const newIndex = State.addConnection();
		if (newIndex !== undefined) {
			refreshTabBar();
			switchToTab(newIndex);
			pushActivity("info", "Connection tab added", `Added port tab index ${newIndex}`);
		}
	});

	const updateBanner = new Instance("Frame");
	updateBanner.Size = new UDim2(1, -16, 0, 24);
	updateBanner.Position = new UDim2(0, 8, 0, 72);
	updateBanner.BackgroundColor3 = Color3.fromRGB(47, 35, 14);
	updateBanner.BorderSizePixel = 0;
	updateBanner.Visible = false;
	updateBanner.Parent = mainFrame;

	const bannerCorner = new Instance("UICorner");
	bannerCorner.CornerRadius = CORNER;
	bannerCorner.Parent = updateBanner;

	const updateBannerText = new Instance("TextLabel");
	updateBannerText.Size = new UDim2(1, -12, 1, 0);
	updateBannerText.Position = new UDim2(0, 8, 0, 0);
	updateBannerText.BackgroundTransparency = 1;
	updateBannerText.Text = "";
	updateBannerText.TextColor3 = C.yellow;
	updateBannerText.TextSize = 9;
	updateBannerText.Font = Enum.Font.GothamMedium;
	updateBannerText.TextXAlignment = Enum.TextXAlignment.Left;
	updateBannerText.Parent = updateBanner;

	const contentY = 100;
	const contentFrame = new Instance("ScrollingFrame");
	contentFrame.Size = new UDim2(1, -16, 1, -(contentY + 8));
	contentFrame.Position = new UDim2(0, 8, 0, contentY);
	contentFrame.BackgroundTransparency = 1;
	contentFrame.BorderSizePixel = 0;
	contentFrame.ScrollBarThickness = 3;
	contentFrame.ScrollBarImageColor3 = C.subtle;
	contentFrame.CanvasSize = new UDim2(0, 0, 0, 0);
	contentFrame.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	contentFrame.Parent = mainFrame;

	const card = new Instance("Frame");
	card.Size = new UDim2(1, 0, 0, 0);
	card.AutomaticSize = Enum.AutomaticSize.Y;
	card.BackgroundColor3 = C.card;
	card.BorderSizePixel = 0;
	card.Parent = contentFrame;

	const cardCorner = new Instance("UICorner");
	cardCorner.CornerRadius = CORNER;
	cardCorner.Parent = card;

	const cardStroke = new Instance("UIStroke");
	cardStroke.Color = C.border;
	cardStroke.Parent = card;

	const cardPadding = new Instance("UIPadding");
	cardPadding.PaddingLeft = new UDim(0, 10);
	cardPadding.PaddingRight = new UDim(0, 10);
	cardPadding.PaddingTop = new UDim(0, 8);
	cardPadding.PaddingBottom = new UDim(0, 10);
	cardPadding.Parent = card;

	const cardLayout = new Instance("UIListLayout");
	cardLayout.Padding = new UDim(0, 6);
	cardLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	cardLayout.Parent = card;

	const urlInput = new Instance("TextBox");
	urlInput.Size = new UDim2(1, 0, 0, 26);
	urlInput.BackgroundColor3 = C.surfaceAlt;
	urlInput.BorderSizePixel = 0;
	urlInput.Text = "http://localhost:3002";
	urlInput.TextColor3 = C.label;
	urlInput.TextSize = 10;
	urlInput.Font = Enum.Font.GothamMedium;
	urlInput.ClearTextOnFocus = false;
	urlInput.PlaceholderText = "Server URL...";
	urlInput.PlaceholderColor3 = C.muted;
	urlInput.LayoutOrder = 1;
	urlInput.Parent = card;

	const urlCorner = new Instance("UICorner");
	urlCorner.CornerRadius = CORNER;
	urlCorner.Parent = urlInput;

	const statusRow = new Instance("Frame");
	statusRow.Size = new UDim2(1, 0, 0, 16);
	statusRow.BackgroundTransparency = 1;
	statusRow.LayoutOrder = 2;
	statusRow.Parent = card;

	const statusLabel = new Instance("TextLabel");
	statusLabel.Size = new UDim2(0.6, 0, 1, 0);
	statusLabel.BackgroundTransparency = 1;
	statusLabel.Text = "Disconnected";
	statusLabel.TextColor3 = C.red;
	statusLabel.TextSize = 10;
	statusLabel.Font = Enum.Font.GothamBold;
	statusLabel.TextXAlignment = Enum.TextXAlignment.Left;
	statusLabel.Parent = statusRow;

	const detailStatusLabel = new Instance("TextLabel");
	detailStatusLabel.Size = new UDim2(0.4, 0, 1, 0);
	detailStatusLabel.Position = new UDim2(0.6, 0, 0, 0);
	detailStatusLabel.BackgroundTransparency = 1;
	detailStatusLabel.Text = "HTTP: X  MCP: X";
	detailStatusLabel.TextColor3 = C.muted;
	detailStatusLabel.TextSize = 9;
	detailStatusLabel.Font = Enum.Font.GothamMedium;
	detailStatusLabel.TextXAlignment = Enum.TextXAlignment.Right;
	detailStatusLabel.Parent = statusRow;

	const stepsFrame = new Instance("Frame");
	stepsFrame.Size = new UDim2(1, 0, 0, 0);
	stepsFrame.AutomaticSize = Enum.AutomaticSize.Y;
	stepsFrame.BackgroundTransparency = 1;
	stepsFrame.LayoutOrder = 3;
	stepsFrame.Parent = card;

	const stepsLayout = new Instance("UIListLayout");
	stepsLayout.Padding = new UDim(0, 2);
	stepsLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	stepsLayout.Parent = stepsFrame;

	function createStepRow(text: string, order: number): [Frame, Frame, TextLabel] {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 14);
		row.BackgroundTransparency = 1;
		row.LayoutOrder = order;
		row.Parent = stepsFrame;

		const dot = new Instance("Frame");
		dot.Size = new UDim2(0, 5, 0, 5);
		dot.Position = new UDim2(0, 1, 0, 4);
		dot.BackgroundColor3 = C.gray;
		dot.BorderSizePixel = 0;
		dot.Parent = row;

		const dotCorner = new Instance("UICorner");
		dotCorner.CornerRadius = new UDim(1, 0);
		dotCorner.Parent = dot;

		const label = new Instance("TextLabel");
		label.Size = new UDim2(1, -12, 1, 0);
		label.Position = new UDim2(0, 12, 0, 0);
		label.BackgroundTransparency = 1;
		label.Text = text;
		label.TextColor3 = C.muted;
		label.TextSize = 9;
		label.Font = Enum.Font.GothamMedium;
		label.TextXAlignment = Enum.TextXAlignment.Left;
		label.Parent = row;

		return [row, dot, label];
	}

	const [, step1Dot, step1Label] = createStepRow("HTTP server", 1);
	const [, step2Dot, step2Label] = createStepRow("MCP bridge", 2);
	const [, step3Dot, step3Label] = createStepRow("Commands", 3);

	const troubleshootLabel = new Instance("TextLabel");
	troubleshootLabel.Size = new UDim2(1, 0, 0, 20);
	troubleshootLabel.BackgroundTransparency = 1;
	troubleshootLabel.TextWrapped = true;
	troubleshootLabel.Visible = false;
	troubleshootLabel.Text = "MCP not responding. Restart server or scan another port.";
	troubleshootLabel.TextColor3 = C.yellow;
	troubleshootLabel.TextSize = 9;
	troubleshootLabel.Font = Enum.Font.GothamMedium;
	troubleshootLabel.TextXAlignment = Enum.TextXAlignment.Left;
	troubleshootLabel.LayoutOrder = 4;
	troubleshootLabel.Parent = card;

	const connectButton = createTextButton(card, "Connect", new UDim2(1, 0, 0, 28), 5);
	const connectStroke = connectButton.FindFirstChildOfClass("UIStroke") as UIStroke;

	connectButton.MouseEnter.Connect(() => {
		buttonHover = true;
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			tweenProp(connectButton, { BackgroundColor3: C.surface });
			tweenProp(connectStroke, { Color: Color3.fromRGB(120, 54, 54) });
		}
	});
	connectButton.MouseLeave.Connect(() => {
		buttonHover = false;
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			setButtonDisconnect(connectButton, connectStroke);
		} else {
			setButtonConnect(connectButton, connectStroke);
		}
	});

	const viewsBar = new Instance("Frame");
	viewsBar.Size = new UDim2(1, 0, 0, 24);
	viewsBar.BackgroundTransparency = 1;
	viewsBar.LayoutOrder = 6;
	viewsBar.Parent = card;

	const viewsLayout = new Instance("UIListLayout");
	viewsLayout.FillDirection = Enum.FillDirection.Horizontal;
	viewsLayout.Padding = new UDim(0, 6);
	viewsLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	viewsLayout.Parent = viewsBar;

	const overviewBtn = createTextButton(viewsBar, "Overview", new UDim2(0.167, -4, 1, 0), 1);
	const activityBtn = createTextButton(viewsBar, "Activity", new UDim2(0.167, -4, 1, 0), 2);
	const agentsBtn = createTextButton(viewsBar, "Agents", new UDim2(0.167, -4, 1, 0), 3);
	const missionBtn = createTextButton(viewsBar, "Mission", new UDim2(0.167, -4, 1, 0), 4);
	const chatBtn = createTextButton(viewsBar, "Chat", new UDim2(0.167, -4, 1, 0), 5);
	const settingsBtn = createTextButton(viewsBar, "Settings", new UDim2(0, 68, 1, 0), 6);
	viewButtons.set("overview", overviewBtn);
	viewButtons.set("activity", activityBtn);
	viewButtons.set("agents", agentsBtn);
	viewButtons.set("mission", missionBtn);
	viewButtons.set("chat", chatBtn);
	viewButtons.set("settings", settingsBtn);

	const overviewPanel = new Instance("Frame");
	overviewPanel.Size = new UDim2(1, 0, 0, 0);
	overviewPanel.AutomaticSize = Enum.AutomaticSize.Y;
	overviewPanel.BackgroundTransparency = 1;
	overviewPanel.LayoutOrder = 7;
	overviewPanel.Parent = card;

	const overviewLayout = new Instance("UIListLayout");
	overviewLayout.Padding = new UDim(0, 6);
	overviewLayout.Parent = overviewPanel;

	createRowLabel(overviewPanel, "Quick actions")

	const qaRow = new Instance("Frame");
	qaRow.Size = new UDim2(1, 0, 0, 56);
	qaRow.BackgroundTransparency = 1;
	qaRow.Parent = overviewPanel;

	const qaLayout = new Instance("UIGridLayout");
	qaLayout.CellSize = new UDim2(0.5, -4, 0, 24);
	qaLayout.CellPadding = new UDim2(0, 6, 0, 6);
	qaLayout.Parent = qaRow;

	const refreshMapBtn = createTextButton(qaRow, "Refresh map", new UDim2(0, 0, 0, 0), 1);
	const discoverPortBtn = createTextButton(qaRow, "Scan ports", new UDim2(0, 0, 0, 0), 2);
	const readyPingBtn = createTextButton(qaRow, "Sync MCP", new UDim2(0, 0, 0, 0), 3);
	const clearFeedBtn = createTextButton(qaRow, "Clear feed", new UDim2(0, 0, 0, 0), 4);

	settingsSummaryLabel = new Instance("TextLabel");
	settingsSummaryLabel.Size = new UDim2(1, 0, 0, 14);
	settingsSummaryLabel.BackgroundTransparency = 1;
	settingsSummaryLabel.TextColor3 = C.muted;
	settingsSummaryLabel.TextSize = 9;
	settingsSummaryLabel.Font = Enum.Font.GothamMedium;
	settingsSummaryLabel.TextXAlignment = Enum.TextXAlignment.Left;
	settingsSummaryLabel.Parent = overviewPanel;

	createRowLabel(overviewPanel, "Agent mapping");

	const mappingCard = new Instance("Frame");
	mappingCard.Size = new UDim2(1, 0, 0, 0);
	mappingCard.AutomaticSize = Enum.AutomaticSize.Y;
	mappingCard.BackgroundColor3 = C.surfaceAlt;
	mappingCard.BorderSizePixel = 0;
	mappingCard.Parent = overviewPanel;

	const mappingCorner = new Instance("UICorner");
	mappingCorner.CornerRadius = CORNER;
	mappingCorner.Parent = mappingCard;

	const mappingStroke = new Instance("UIStroke");
	mappingStroke.Color = C.border;
	mappingStroke.Parent = mappingCard;

	const mappingPadding = new Instance("UIPadding");
	mappingPadding.PaddingLeft = new UDim(0, 8);
	mappingPadding.PaddingRight = new UDim(0, 8);
	mappingPadding.PaddingTop = new UDim(0, 8);
	mappingPadding.PaddingBottom = new UDim(0, 8);
	mappingPadding.Parent = mappingCard;

	const mappingLayout = new Instance("UIListLayout");
	mappingLayout.Padding = new UDim(0, 4);
	mappingLayout.Parent = mappingCard;

	agentMappingHeadlineLabel = new Instance("TextLabel");
	agentMappingHeadlineLabel.Size = new UDim2(1, 0, 0, 16);
	agentMappingHeadlineLabel.BackgroundTransparency = 1;
	agentMappingHeadlineLabel.Text = "Loading mapping...";
	agentMappingHeadlineLabel.TextColor3 = C.label;
	agentMappingHeadlineLabel.TextSize = 10;
	agentMappingHeadlineLabel.Font = Enum.Font.GothamSemibold;
	agentMappingHeadlineLabel.TextXAlignment = Enum.TextXAlignment.Left;
	agentMappingHeadlineLabel.Parent = mappingCard;

	agentMappingMetaLabel = new Instance("TextLabel");
	agentMappingMetaLabel.Size = new UDim2(1, 0, 0, 14);
	agentMappingMetaLabel.BackgroundTransparency = 1;
	agentMappingMetaLabel.Text = "";
	agentMappingMetaLabel.TextColor3 = C.muted;
	agentMappingMetaLabel.TextSize = 9;
	agentMappingMetaLabel.Font = Enum.Font.GothamMedium;
	agentMappingMetaLabel.TextXAlignment = Enum.TextXAlignment.Left;
	agentMappingMetaLabel.Parent = mappingCard;

	agentMappingContextLabel = new Instance("TextLabel");
	agentMappingContextLabel.Size = new UDim2(1, 0, 0, 28);
	agentMappingContextLabel.BackgroundTransparency = 1;
	agentMappingContextLabel.Text = "";
	agentMappingContextLabel.TextWrapped = true;
	agentMappingContextLabel.TextColor3 = C.muted;
	agentMappingContextLabel.TextSize = 9;
	agentMappingContextLabel.Font = Enum.Font.GothamMedium;
	agentMappingContextLabel.TextXAlignment = Enum.TextXAlignment.Left;
	agentMappingContextLabel.TextYAlignment = Enum.TextYAlignment.Top;
	agentMappingContextLabel.Parent = mappingCard;

	function createMappingDetailLabel(): TextLabel {
		const label = new Instance("TextLabel");
		label.Size = new UDim2(1, 0, 0, 28);
		label.BackgroundTransparency = 1;
		label.Text = "";
		label.TextWrapped = true;
		label.TextColor3 = C.label;
		label.TextSize = 9;
		label.Font = Enum.Font.GothamMedium;
		label.TextXAlignment = Enum.TextXAlignment.Left;
		label.TextYAlignment = Enum.TextYAlignment.Top;
		label.Parent = mappingCard;
		return label;
	}

	agentMappingRootsLabel = createMappingDetailLabel();
	agentMappingSubsystemsLabel = createMappingDetailLabel();
	agentMappingScriptsLabel = createMappingDetailLabel();

	createRowLabel(overviewPanel, "Diagnostics cockpit");

	const diagnosticsCard = new Instance("Frame");
	diagnosticsCard.Size = new UDim2(1, 0, 0, 0);
	diagnosticsCard.AutomaticSize = Enum.AutomaticSize.Y;
	diagnosticsCard.BackgroundColor3 = C.surfaceAlt;
	diagnosticsCard.BorderSizePixel = 0;
	diagnosticsCard.Parent = overviewPanel;

	const diagnosticsCorner = new Instance("UICorner");
	diagnosticsCorner.CornerRadius = CORNER;
	diagnosticsCorner.Parent = diagnosticsCard;

	const diagnosticsStroke = new Instance("UIStroke");
	diagnosticsStroke.Color = C.border;
	diagnosticsStroke.Parent = diagnosticsCard;

	const diagnosticsPadding = new Instance("UIPadding");
	diagnosticsPadding.PaddingLeft = new UDim(0, 8);
	diagnosticsPadding.PaddingRight = new UDim(0, 8);
	diagnosticsPadding.PaddingTop = new UDim(0, 8);
	diagnosticsPadding.PaddingBottom = new UDim(0, 8);
	diagnosticsPadding.Parent = diagnosticsCard;

	const diagnosticsLayout = new Instance("UIListLayout");
	diagnosticsLayout.Padding = new UDim(0, 4);
	diagnosticsLayout.Parent = diagnosticsCard;

	diagnosticsBridgeLabel = createCompactLabel(diagnosticsCard, 9, C.label);
	diagnosticsPluginLabel = createCompactLabel(diagnosticsCard, 9, C.label);
	diagnosticsMcpLabel = createCompactLabel(diagnosticsCard, 9, C.label);
	diagnosticsEndpointSupportLabel = createCompactLabel(diagnosticsCard, 8, C.muted);
	diagnosticsCacheLabel = createCompactLabel(diagnosticsCard, 8, C.muted);
	diagnosticsWriteQueueLabel = createCompactLabel(diagnosticsCard, 8, C.muted);
	diagnosticsErrorLabel = createCompactLabel(diagnosticsCard, 8, C.yellow);
	diagnosticsCauseLabel = createCompactLabel(diagnosticsCard, 8, C.muted);
	diagnosticsUpdatedLabel = createCompactLabel(diagnosticsCard, 8, C.muted);

	createRowLabel(overviewPanel, "Swarm orchestrator");

	const swarmCard = new Instance("Frame");
	swarmCard.Size = new UDim2(1, 0, 0, 0);
	swarmCard.AutomaticSize = Enum.AutomaticSize.Y;
	swarmCard.BackgroundColor3 = C.surfaceAlt;
	swarmCard.BorderSizePixel = 0;
	swarmCard.Parent = overviewPanel;

	const swarmCorner = new Instance("UICorner");
	swarmCorner.CornerRadius = CORNER;
	swarmCorner.Parent = swarmCard;

	const swarmStroke = new Instance("UIStroke");
	swarmStroke.Color = C.border;
	swarmStroke.Parent = swarmCard;

	const swarmPadding = new Instance("UIPadding");
	swarmPadding.PaddingLeft = new UDim(0, 8);
	swarmPadding.PaddingRight = new UDim(0, 8);
	swarmPadding.PaddingTop = new UDim(0, 8);
	swarmPadding.PaddingBottom = new UDim(0, 8);
	swarmPadding.Parent = swarmCard;

	const swarmLayout = new Instance("UIListLayout");
	swarmLayout.Padding = new UDim(0, 4);
	swarmLayout.Parent = swarmCard;

	const swarmHeaderRow = new Instance("Frame");
	swarmHeaderRow.Size = new UDim2(1, 0, 0, 18);
	swarmHeaderRow.BackgroundTransparency = 1;
	swarmHeaderRow.Parent = swarmCard;

	const swarmHeaderLabel = new Instance("TextLabel");
	swarmHeaderLabel.Size = new UDim2(0.6, 0, 1, 0);
	swarmHeaderLabel.BackgroundTransparency = 1;
	swarmHeaderLabel.Text = "Active agents";
	swarmHeaderLabel.TextColor3 = C.label;
	swarmHeaderLabel.TextSize = 10;
	swarmHeaderLabel.Font = Enum.Font.GothamSemibold;
	swarmHeaderLabel.TextXAlignment = Enum.TextXAlignment.Left;
	swarmHeaderLabel.Parent = swarmHeaderRow;

	const swarmStatusLabel = new Instance("TextLabel");
	swarmStatusLabel.Size = new UDim2(0.4, 0, 1, 0);
	swarmStatusLabel.Position = new UDim2(0.6, 0, 0, 0);
	swarmStatusLabel.BackgroundTransparency = 1;
	swarmStatusLabel.Text = "Tasks: 0/0";
	swarmStatusLabel.TextColor3 = C.muted;
	swarmStatusLabel.TextSize = 9;
	swarmStatusLabel.Font = Enum.Font.GothamMedium;
	swarmStatusLabel.TextXAlignment = Enum.TextXAlignment.Right;
	swarmStatusLabel.Parent = swarmHeaderRow;

	const agentTeamColors: Record<string, Color3> = {
		claude: C.blue,
		codex: C.green,
		gemini: C.yellow,
	};

	function createSwarmAgentRow(parent: Instance, teamType: string, teamLabel: string): Frame {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 22);
		row.BackgroundTransparency = 1;
		row.Parent = parent;

		const dot = new Instance("Frame");
		dot.Size = new UDim2(0, 6, 0, 6);
		dot.Position = new UDim2(0, 4, 0.5, -3);
		dot.BackgroundColor3 = agentTeamColors[teamType] ?? C.gray;
		dot.BorderSizePixel = 0;
		dot.Parent = row;

		const dotCorner = new Instance("UICorner");
		dotCorner.CornerRadius = new UDim(1, 0);
		dotCorner.Parent = dot;

		const label = new Instance("TextLabel");
		label.Size = new UDim2(0.4, 0, 1, 0);
		label.Position = new UDim2(0, 16, 0, 0);
		label.BackgroundTransparency = 1;
		label.Text = teamLabel;
		label.TextColor3 = agentTeamColors[teamType] ?? C.label;
		label.TextSize = 9;
		label.Font = Enum.Font.GothamMedium;
		label.TextXAlignment = Enum.TextXAlignment.Left;
		label.Parent = row;

		const statusText = new Instance("TextLabel");
		statusText.Size = new UDim2(0.3, 0, 1, 0);
		statusText.Position = new UDim2(0.4, 0, 0, 0);
		statusText.BackgroundTransparency = 1;
		statusText.Text = "idle";
		statusText.TextColor3 = C.muted;
		statusText.TextSize = 8;
		statusText.Font = Enum.Font.GothamMedium;
		statusText.TextXAlignment = Enum.TextXAlignment.Center;
		statusText.Name = teamType + "Status";
		statusText.Parent = row;

		const taskText = new Instance("TextLabel");
		taskText.Size = new UDim2(0.3, 0, 1, 0);
		taskText.Position = new UDim2(0.7, 0, 0, 0);
		taskText.BackgroundTransparency = 1;
		taskText.Text = "0 tasks";
		taskText.TextColor3 = C.muted;
		taskText.TextSize = 8;
		taskText.Font = Enum.Font.GothamMedium;
		taskText.TextXAlignment = Enum.TextXAlignment.Right;
		taskText.Name = teamType + "Tasks";
		taskText.Parent = row;

		return row;
	}

	createSwarmAgentRow(swarmCard, "claude", "Claude");
	createSwarmAgentRow(swarmCard, "codex", "Codex");
	createSwarmAgentRow(swarmCard, "gemini", "Gemini");

	createRowLabel(overviewPanel, "Structure Map Explorer");

	const explorerCard = new Instance("Frame");
	explorerCard.Size = new UDim2(1, 0, 0, 0);
	explorerCard.AutomaticSize = Enum.AutomaticSize.Y;
	explorerCard.BackgroundColor3 = C.surfaceAlt;
	explorerCard.BorderSizePixel = 0;
	explorerCard.Parent = overviewPanel;

	const explorerCorner = new Instance("UICorner");
	explorerCorner.CornerRadius = CORNER;
	explorerCorner.Parent = explorerCard;

	const explorerStroke = new Instance("UIStroke");
	explorerStroke.Color = C.border;
	explorerStroke.Parent = explorerCard;

	const explorerPadding = new Instance("UIPadding");
	explorerPadding.PaddingLeft = new UDim(0, 8);
	explorerPadding.PaddingRight = new UDim(0, 8);
	explorerPadding.PaddingTop = new UDim(0, 8);
	explorerPadding.PaddingBottom = new UDim(0, 8);
	explorerPadding.Parent = explorerCard;

	const explorerLayout = new Instance("UIListLayout");
	explorerLayout.Padding = new UDim(0, 4);
	explorerLayout.Parent = explorerCard;

	function createExplorerInput(parent: Frame, placeholder: string): TextBox {
		const input = new Instance("TextBox");
		input.Size = new UDim2(1, 0, 0, 22);
		input.BackgroundColor3 = C.surface;
		input.BorderSizePixel = 0;
		input.Text = "";
		input.ClearTextOnFocus = false;
		input.PlaceholderText = placeholder;
		input.PlaceholderColor3 = C.muted;
		input.TextColor3 = C.label;
		input.TextSize = 9;
		input.Font = Enum.Font.GothamMedium;
		input.Parent = parent;

		const inputCorner = new Instance("UICorner");
		inputCorner.CornerRadius = CORNER;
		inputCorner.Parent = input;
		return input;
	}

	explorerSubsystemInput = createExplorerInput(explorerCard, "Filter subsystem (e.g. UI, Combat)");
	explorerScriptTypeInput = createExplorerInput(explorerCard, "Filter script type (Script, LocalScript, ModuleScript)");
	explorerPathPrefixInput = createExplorerInput(explorerCard, "Filter path prefix (game.ServerScriptService)");
	explorerSummaryStatusInput = createExplorerInput(explorerCard, "Summary status: missing | stale | fresh");

	const explorerActionRow = new Instance("Frame");
	explorerActionRow.Size = new UDim2(1, 0, 0, 24);
	explorerActionRow.BackgroundTransparency = 1;
	explorerActionRow.Parent = explorerCard;

	const explorerRefreshBtn = createTextButton(explorerActionRow, "Apply filters", new UDim2(0.5, -3, 1, 0));
	explorerRefreshBtn.Position = new UDim2(0, 0, 0, 0);
	const explorerClearBtn = createTextButton(explorerActionRow, "Clear filters", new UDim2(0.5, -3, 1, 0));
	explorerClearBtn.Position = new UDim2(0.5, 3, 0, 0);

	explorerResultList = new Instance("Frame");
	explorerResultList.Size = new UDim2(1, 0, 0, 190);
	explorerResultList.BackgroundTransparency = 1;
	explorerResultList.Parent = explorerCard;

	const explorerResultsLayout = new Instance("UIListLayout");
	explorerResultsLayout.Name = "Layout";
	explorerResultsLayout.Padding = new UDim(0, 4);
	explorerResultsLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	explorerResultsLayout.Parent = explorerResultList;

	explorerRefreshBtn.Activated.Connect(() => {
		rebuildStructureExplorerList();
	});
	explorerClearBtn.Activated.Connect(() => {
		if (explorerSubsystemInput) explorerSubsystemInput.Text = "";
		if (explorerScriptTypeInput) explorerScriptTypeInput.Text = "";
		if (explorerPathPrefixInput) explorerPathPrefixInput.Text = "";
		if (explorerSummaryStatusInput) explorerSummaryStatusInput.Text = "";
		rebuildStructureExplorerList();
	});
	explorerSubsystemInput.FocusLost.Connect(() => rebuildStructureExplorerList());
	explorerScriptTypeInput.FocusLost.Connect(() => rebuildStructureExplorerList());
	explorerPathPrefixInput.FocusLost.Connect(() => rebuildStructureExplorerList());
	explorerSummaryStatusInput.FocusLost.Connect(() => rebuildStructureExplorerList());

	const activityPanel = new Instance("Frame");
	activityPanel.Size = new UDim2(1, 0, 0, 340);
	activityPanel.BackgroundTransparency = 1;
	activityPanel.LayoutOrder = 8;
	activityPanel.Visible = false;
	activityPanel.Parent = card;

	createRowLabel(activityPanel, "MCP activity feed");

	const activityFilterRow = new Instance("Frame");
	activityFilterRow.Size = new UDim2(1, 0, 0, 48);
	activityFilterRow.Position = new UDim2(0, 0, 0, 18);
	activityFilterRow.BackgroundTransparency = 1;
	activityFilterRow.Parent = activityPanel;

	const activityFilterGrid = new Instance("UIGridLayout");
	activityFilterGrid.CellSize = new UDim2(0.2, -4, 0, 20);
	activityFilterGrid.CellPadding = new UDim2(0, 4, 0, 4);
	activityFilterGrid.Parent = activityFilterRow;

	activityFilterReadBtn = createTextButton(activityFilterRow, "Reads ON", new UDim2(0, 0, 0, 0), 1);
	activityFilterWriteBtn = createTextButton(activityFilterRow, "Writes ON", new UDim2(0, 0, 0, 0), 2);
	activityFilterErrorBtn = createTextButton(activityFilterRow, "Errors ON", new UDim2(0, 0, 0, 0), 3);
	activityFilterStructureBtn = createTextButton(activityFilterRow, "Structure ON", new UDim2(0, 0, 0, 0), 4);
	activityGroupBtn = createTextButton(activityFilterRow, "Group: path", new UDim2(0, 0, 0, 0), 5);

	const activityList = new Instance("Frame");
	activityList.Name = "ActivityList";
	activityList.Size = new UDim2(1, 0, 1, -70);
	activityList.Position = new UDim2(0, 0, 0, 70);
	activityList.BackgroundTransparency = 1;
	activityList.Parent = activityPanel;

	const activityLayout = new Instance("UIListLayout");
	activityLayout.Padding = new UDim(0, 4);
	activityLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	activityLayout.Parent = activityList;

	const agentsPanel = new Instance("Frame");
	agentsPanel.Size = new UDim2(1, 0, 0, 340);
	agentsPanel.BackgroundTransparency = 1;
	agentsPanel.LayoutOrder = 8;
	agentsPanel.Visible = false;
	agentsPanel.Parent = card;

	createRowLabel(agentsPanel, "AI Agent Status");

	const agentsStatusRow = new Instance("Frame");
	agentsStatusRow.Size = new UDim2(1, 0, 0, 60);
	agentsStatusRow.Position = new UDim2(0, 0, 0, 18);
	agentsStatusRow.BackgroundColor3 = C.surfaceAlt;
	agentsStatusRow.BorderSizePixel = 0;
	agentsStatusRow.Parent = agentsPanel;

	const agentsStatusCorner = new Instance("UICorner");
	agentsStatusCorner.CornerRadius = CORNER;
	agentsStatusCorner.Parent = agentsStatusRow;

	const agentsStatusPadding = new Instance("UIPadding");
	agentsStatusPadding.PaddingLeft = new UDim(0, 8);
	agentsStatusPadding.PaddingRight = new UDim(0, 8);
	agentsStatusPadding.PaddingTop = new UDim(0, 6);
	agentsStatusPadding.PaddingBottom = new UDim(0, 6);
	agentsStatusPadding.Parent = agentsStatusRow;

	agentStatusSummaryLabel = new Instance("TextLabel");
	agentStatusSummaryLabel.Size = new UDim2(1, 0, 0, 14);
	agentStatusSummaryLabel.BackgroundTransparency = 1;
	agentStatusSummaryLabel.Text = "No active agents";
	agentStatusSummaryLabel.TextColor3 = C.muted;
	agentStatusSummaryLabel.TextSize = 9;
	agentStatusSummaryLabel.Font = Enum.Font.GothamMedium;
	agentStatusSummaryLabel.TextXAlignment = Enum.TextXAlignment.Left;
	agentStatusSummaryLabel.Parent = agentsStatusRow;

	agentMetricsLabel = new Instance("TextLabel");
	agentMetricsLabel.Size = new UDim2(1, 0, 0, 14);
	agentMetricsLabel.Position = new UDim2(0, 0, 0, 16);
	agentMetricsLabel.BackgroundTransparency = 1;
	agentMetricsLabel.Text = "Tokens: 0 in / 0 out | Latency: 0ms";
	agentMetricsLabel.TextColor3 = C.label;
	agentMetricsLabel.TextSize = 9;
	agentMetricsLabel.Font = Enum.Font.GothamMedium;
	agentMetricsLabel.TextXAlignment = Enum.TextXAlignment.Left;
	agentMetricsLabel.Parent = agentsStatusRow;

	agentThreadsLabel = new Instance("TextLabel");
	agentThreadsLabel.Size = new UDim2(1, 0, 0, 14);
	agentThreadsLabel.Position = new UDim2(0, 0, 0, 30);
	agentThreadsLabel.BackgroundTransparency = 1;
	agentThreadsLabel.Text = "Threads: 0 | Requests: 0";
	agentThreadsLabel.TextColor3 = C.muted;
	agentThreadsLabel.TextSize = 9;
	agentThreadsLabel.Font = Enum.Font.GothamMedium;
	agentThreadsLabel.TextXAlignment = Enum.TextXAlignment.Left;
	agentThreadsLabel.Parent = agentsStatusRow;

	createRowLabel(agentsPanel, "Agent Controls");

	const agentControlsRow = new Instance("Frame");
	agentControlsRow.Size = new UDim2(1, 0, 0, 28);
	agentControlsRow.BackgroundTransparency = 1;
	agentControlsRow.Parent = agentsPanel;

	const agentControlsLayout = new Instance("UIGridLayout");
	agentControlsLayout.CellSize = new UDim2(0.33, -4, 0, 24);
	agentControlsLayout.CellPadding = new UDim2(0, 4, 0, 4);
	agentControlsLayout.Parent = agentControlsRow;

	const pauseAllBtn = createTextButton(agentControlsRow, "Pause All", new UDim2(0, 0, 0, 0), 1);
	const resumeAllBtn = createTextButton(agentControlsRow, "Resume All", new UDim2(0, 0, 0, 0), 2);
	const stopAllBtn = createTextButton(agentControlsRow, "Stop All", new UDim2(0, 0, 0, 0), 3);

	const chatPanel = new Instance("Frame");
	chatPanel.Size = new UDim2(1, 0, 0, 340);
	chatPanel.BackgroundTransparency = 1;
	chatPanel.LayoutOrder = 8;
	chatPanel.Visible = false;
	chatPanel.Parent = card;

	createRowLabel(chatPanel, "Direct Chat with AI Agent");

	chatMessagesList = new Instance("ScrollingFrame");
	chatMessagesList.Size = new UDim2(1, 0, 1, -70);
	chatMessagesList.Position = new UDim2(0, 0, 0, 18);
	chatMessagesList.BackgroundColor3 = C.surfaceAlt;
	chatMessagesList.BorderSizePixel = 0;
	chatMessagesList.ScrollBarThickness = 3;
	chatMessagesList.ScrollBarImageColor3 = C.subtle;
	chatMessagesList.CanvasSize = new UDim2(0, 0, 0, 0);
	chatMessagesList.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	chatMessagesList.Parent = chatPanel;

	const chatMessagesCorner = new Instance("UICorner");
	chatMessagesCorner.CornerRadius = CORNER;
	chatMessagesCorner.Parent = chatMessagesList;

	const chatMessagesLayout = new Instance("UIListLayout");
	chatMessagesLayout.Padding = new UDim(0, 4);
	chatMessagesLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	chatMessagesLayout.Parent = chatMessagesList;

	const chatInputRow = new Instance("Frame");
	chatInputRow.Size = new UDim2(1, 0, 0, 30);
	chatInputRow.Position = new UDim2(0, 0, 1, -36);
	chatInputRow.BackgroundTransparency = 1;
	chatInputRow.Parent = chatPanel;

	chatInputBox = new Instance("TextBox");
	chatInputBox.Size = new UDim2(1, -50, 1, 0);
	chatInputBox.BackgroundColor3 = C.surfaceAlt;
	chatInputBox.BorderSizePixel = 0;
	chatInputBox.Text = "";
	chatInputBox.TextColor3 = C.label;
	chatInputBox.TextSize = 10;
	chatInputBox.Font = Enum.Font.GothamMedium;
	chatInputBox.ClearTextOnFocus = false;
	chatInputBox.PlaceholderText = "Type a message...";
	chatInputBox.PlaceholderColor3 = C.muted;
	chatInputBox.Parent = chatInputRow;

	const chatInputCorner = new Instance("UICorner");
	chatInputCorner.CornerRadius = CORNER;
	chatInputCorner.Parent = chatInputBox;

	const chatSendBtn = createTextButton(chatInputRow, "Send", new UDim2(0, 46, 1, 0), 1);
	chatSendBtn.Position = new UDim2(1, -50, 0, 0);

	const chatClearBtn = createTextButton(chatPanel, "Clear", new UDim2(0, 60, 0, 22), 2);

	const missionPanel = new Instance("Frame");
	missionPanel.Name = "MissionPanel";
	missionPanel.Size = new UDim2(1, 0, 0, 340);
	missionPanel.BackgroundTransparency = 1;
	missionPanel.LayoutOrder = 8;
	missionPanel.Visible = false;
	missionPanel.Parent = card;

	createRowLabel(missionPanel, "Current Mission");

	const missionCard = new Instance("Frame");
	missionCard.Size = new UDim2(1, 0, 0, 0);
	missionCard.AutomaticSize = Enum.AutomaticSize.Y;
	missionCard.BackgroundColor3 = C.surfaceAlt;
	missionCard.BorderSizePixel = 0;
	missionCard.Parent = missionPanel;

	const missionCorner = new Instance("UICorner");
	missionCorner.CornerRadius = CORNER;
	missionCorner.Parent = missionCard;

	const missionPadding = new Instance("UIPadding");
	missionPadding.PaddingLeft = new UDim(0, 8);
	missionPadding.PaddingRight = new UDim(0, 8);
	missionPadding.PaddingTop = new UDim(0, 8);
	missionPadding.PaddingBottom = new UDim(0, 8);
	missionPadding.Parent = missionCard;

	const missionLayout = new Instance("UIListLayout");
	missionLayout.Padding = new UDim(0, 4);
	missionLayout.Parent = missionCard;

	const missionGoalRow = new Instance("Frame");
	missionGoalRow.Size = new UDim2(1, 0, 0, 16);
	missionGoalRow.BackgroundTransparency = 1;
	missionGoalRow.Parent = missionCard;

	const missionGoalTitle = new Instance("TextLabel");
	missionGoalTitle.Size = new UDim2(0, 60, 1, 0);
	missionGoalTitle.BackgroundTransparency = 1;
	missionGoalTitle.Text = "Goal:";
	missionGoalTitle.TextColor3 = C.muted;
	missionGoalTitle.TextSize = 9;
	missionGoalTitle.Font = Enum.Font.GothamMedium;
	missionGoalTitle.TextXAlignment = Enum.TextXAlignment.Left;
	missionGoalTitle.Parent = missionGoalRow;

	missionGoalLabel = new Instance("TextLabel");
	missionGoalLabel.Size = new UDim2(1, -60, 1, 0);
	missionGoalLabel.Position = new UDim2(0, 60, 0, 0);
	missionGoalLabel.BackgroundTransparency = 1;
	missionGoalLabel.Text = "No active mission";
	missionGoalLabel.TextColor3 = C.label;
	missionGoalLabel.TextSize = 9;
	missionGoalLabel.Font = Enum.Font.GothamSemibold;
	missionGoalLabel.TextXAlignment = Enum.TextXAlignment.Left;
	missionGoalLabel.TextTruncate = Enum.TextTruncate.AtEnd;
	missionGoalLabel.Parent = missionGoalRow;

	const missionPhaseRow = new Instance("Frame");
	missionPhaseRow.Size = new UDim2(1, 0, 0, 18);
	missionPhaseRow.BackgroundTransparency = 1;
	missionPhaseRow.Parent = missionCard;

	missionPhaseLabel = new Instance("TextLabel");
	missionPhaseLabel.Size = new UDim2(0.4, 0, 1, 0);
	missionPhaseLabel.BackgroundTransparency = 1;
	missionPhaseLabel.Text = "Phase: idle";
	missionPhaseLabel.TextColor3 = C.gray;
	missionPhaseLabel.TextSize = 9;
	missionPhaseLabel.Font = Enum.Font.GothamSemibold;
	missionPhaseLabel.TextXAlignment = Enum.TextXAlignment.Left;
	missionPhaseLabel.Parent = missionPhaseRow;

	missionProgressLabel = new Instance("TextLabel");
	missionProgressLabel.Size = new UDim2(0.3, 0, 1, 0);
	missionProgressLabel.Position = new UDim2(0.4, 0, 0, 0);
	missionProgressLabel.BackgroundTransparency = 1;
	missionProgressLabel.Text = "Step 0/0";
	missionProgressLabel.TextColor3 = C.muted;
	missionProgressLabel.TextSize = 9;
	missionProgressLabel.Font = Enum.Font.GothamMedium;
	missionProgressLabel.TextXAlignment = Enum.TextXAlignment.Center;
	missionProgressLabel.Parent = missionPhaseRow;

	const missionPhaseBar = new Instance("Frame");
	missionPhaseBar.Size = new UDim2(0.3, 0, 0, 4);
	missionPhaseBar.Position = new UDim2(0.7, 0, 0.5, -2);
	missionPhaseBar.BackgroundColor3 = C.border;
	missionPhaseBar.BorderSizePixel = 0;
	missionPhaseBar.Parent = missionPhaseRow;

	const missionPhaseBarFill = new Instance("Frame");
	missionPhaseBarFill.Name = "PhaseBarFill";
	missionPhaseBarFill.Size = new UDim2(0, 0, 1, 0);
	missionPhaseBarFill.BackgroundColor3 = C.green;
	missionPhaseBarFill.BorderSizePixel = 0;
	missionPhaseBarFill.Parent = missionPhaseBar;

	const missionPhaseBarCorner = new Instance("UICorner");
	missionPhaseBarCorner.CornerRadius = new UDim(1, 0);
	missionPhaseBarCorner.Parent = missionPhaseBar;

	missionReasonLabel = new Instance("TextLabel");
	missionReasonLabel.Size = new UDim2(1, 0, 0, 28);
	missionReasonLabel.BackgroundTransparency = 1;
	missionReasonLabel.Text = "";
	missionReasonLabel.TextWrapped = true;
	missionReasonLabel.TextColor3 = C.muted;
	missionReasonLabel.TextSize = 8;
	missionReasonLabel.Font = Enum.Font.GothamMedium;
	missionReasonLabel.TextXAlignment = Enum.TextXAlignment.Left;
	missionReasonLabel.TextYAlignment = Enum.TextYAlignment.Top;
	missionReasonLabel.Parent = missionCard;

	missionActionLabel = new Instance("TextLabel");
	missionActionLabel.Size = new UDim2(1, 0, 0, 14);
	missionActionLabel.BackgroundTransparency = 1;
	missionActionLabel.Text = "";
	missionActionLabel.TextColor3 = C.blue;
	missionActionLabel.TextSize = 8;
	missionActionLabel.Font = Enum.Font.GothamMedium;
	missionActionLabel.TextXAlignment = Enum.TextXAlignment.Left;
	missionActionLabel.Parent = missionCard;

	createRowLabel(missionPanel, "Step Timeline");

	stepTimelineList = new Instance("Frame");
	stepTimelineList.Name = "StepTimeline";
	stepTimelineList.Size = new UDim2(1, 0, 0, 80);
	stepTimelineList.BackgroundTransparency = 1;
	stepTimelineList.Parent = missionPanel;

	const stepTimelineLayout = new Instance("UIListLayout");
	stepTimelineLayout.Padding = new UDim(0, 4);
	stepTimelineLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	stepTimelineLayout.Parent = stepTimelineList;

	createRowLabel(missionPanel, "Team Selection");

	const teamSelectRow = new Instance("Frame");
	teamSelectRow.Size = new UDim2(1, 0, 0, 60);
	teamSelectRow.BackgroundTransparency = 1;
	teamSelectRow.Parent = missionPanel;

	const teamSelectGrid = new Instance("UIGridLayout");
	teamSelectGrid.CellSize = new UDim2(0.333, -4, 0, 50);
	teamSelectGrid.CellPadding = new UDim2(0, 4, 0, 4);
	teamSelectGrid.Parent = teamSelectRow;

	const agentTeamColors: Record<string, Color3> = {
		claude: C.blue,
		codex: C.green,
		gemini: C.yellow,
	};

	function createTeamSelectCard(parent: Instance, teamType: string, label: string, color: Color3): Frame {
		const card = new Instance("Frame");
		card.Name = teamType + "Card";
		card.Size = new UDim2(0, 0, 0, 0);
		card.BackgroundColor3 = C.surfaceAlt;
		card.BorderSizePixel = 0;
		card.Parent = parent;

		const corner = new Instance("UICorner");
		corner.CornerRadius = CORNER;
		corner.Parent = card;

		const stroke = new Instance("UIStroke");
		stroke.Name = "CardStroke";
		stroke.Color = C.border;
		stroke.Thickness = 1;
		stroke.Parent = card;

		const cardLayout = new Instance("UIListLayout");
		cardLayout.Padding = new UDim(0, 2);
		cardLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		cardLayout.Parent = card;

		const headerRow = new Instance("Frame");
		headerRow.Size = new UDim2(1, 0, 0, 18);
		headerRow.BackgroundTransparency = 1;
		headerRow.Parent = card;

		const dot = new Instance("Frame");
		dot.Size = new UDim2(0, 6, 0, 6);
		dot.Position = new UDim2(0, 4, 0.5, -3);
		dot.BackgroundColor3 = color;
		dot.BorderSizePixel = 0;
		dot.Parent = headerRow;

		const dotCorner = new Instance("UICorner");
		dotCorner.CornerRadius = new UDim(1, 0);
		dotCorner.Parent = dot;

		const nameLabel = new Instance("TextLabel");
		nameLabel.Size = new UDim2(1, -16, 1, 0);
		nameLabel.Position = new UDim2(0, 14, 0, 0);
		nameLabel.BackgroundTransparency = 1;
		nameLabel.Text = label;
		nameLabel.TextColor3 = color;
		nameLabel.TextSize = 9;
		nameLabel.Font = Enum.Font.GothamBold;
		nameLabel.TextXAlignment = Enum.TextXAlignment.Left;
		nameLabel.Parent = headerRow;

		const statusRow = new Instance("Frame");
		statusRow.Size = new UDim2(1, 0, 0, 14);
		statusRow.BackgroundTransparency = 1;
		statusRow.Parent = card;

		const statusLabel = new Instance("TextLabel");
		statusLabel.Size = new UDim2(0.6, 0, 1, 0);
		statusLabel.BackgroundTransparency = 1;
		statusLabel.Text = "status";
		statusLabel.TextColor3 = C.muted;
		statusLabel.TextSize = 8;
		statusLabel.Font = Enum.Font.GothamMedium;
		statusLabel.TextXAlignment = Enum.TextXAlignment.Left;
		statusLabel.Name = teamType + "Status";
		statusLabel.Parent = statusRow;

		const selectBtn = createTextButton(statusRow, "Select", new UDim2(0, 40, 0, 14));
		selectBtn.Name = teamType + "Select";
		selectBtn.TextSize = 8;
		selectBtn.Position = new UDim2(1, -44, 0, 0);

		return card;
	}

	const claudeTeamCard = createTeamSelectCard(teamSelectRow, "claude", "Claude", C.blue);
	const codexTeamCard = createTeamSelectCard(teamSelectRow, "codex", "Codex", C.green);
	const geminiTeamCard = createTeamSelectCard(teamSelectRow, "gemini", "Gemini", C.yellow);
	teamSelectCards.set("claude", claudeTeamCard);
	teamSelectCards.set("codex", codexTeamCard);
	teamSelectCards.set("gemini", geminiTeamCard);

	const orchestratorRow = new Instance("Frame");
	orchestratorRow.Size = new UDim2(1, 0, 0, 24);
	orchestratorRow.BackgroundTransparency = 1;
	orchestratorRow.Parent = missionPanel;

	const orchestratorLabel = new Instance("TextLabel");
	orchestratorLabel.Size = new UDim2(0.6, 0, 1, 0);
	orchestratorLabel.BackgroundTransparency = 1;
	orchestratorLabel.Text = "Orchestrator:";
	orchestratorLabel.TextColor3 = C.label;
	orchestratorLabel.TextSize = 9;
	orchestratorLabel.Font = Enum.Font.GothamSemibold;
	orchestratorLabel.TextXAlignment = Enum.TextXAlignment.Left;
	orchestratorLabel.Parent = orchestratorRow;

	orchestratorModeLabel = new Instance("TextLabel");
	orchestratorModeLabel.Size = new UDim2(0.4, 0, 1, 0);
	orchestratorModeLabel.Position = new UDim2(0.6, 0, 0, 0);
	orchestratorModeLabel.BackgroundTransparency = 1;
	orchestratorModeLabel.Text = "balanced";
	orchestratorModeLabel.TextColor3 = C.green;
	orchestratorModeLabel.TextSize = 9;
	orchestratorModeLabel.Font = Enum.Font.GothamMedium;
	orchestratorModeLabel.TextXAlignment = Enum.TextXAlignment.Right;
	orchestratorModeLabel.Parent = orchestratorRow;

	tasksPanel = new Instance("Frame");
	tasksPanel.Size = new UDim2(1, 0, 0, 340);
	tasksPanel.BackgroundTransparency = 1;
	tasksPanel.LayoutOrder = 8;
	tasksPanel.Visible = true;
	tasksPanel.Parent = card;

	createRowLabel(tasksPanel, "Agent Task Queue");

	const tasksHeaderRow = new Instance("Frame");
	tasksHeaderRow.Size = new UDim2(1, 0, 0, 22);
	tasksHeaderRow.BackgroundTransparency = 1;
	tasksHeaderRow.Parent = tasksPanel;

	const tasksHeaderLabel = new Instance("TextLabel");
	tasksHeaderLabel.Size = new UDim2(0.6, 0, 1, 0);
	tasksHeaderLabel.BackgroundTransparency = 1;
	tasksHeaderLabel.Text = "Task";
	tasksHeaderLabel.TextColor3 = C.label;
	tasksHeaderLabel.TextSize = 9;
	tasksHeaderLabel.Font = Enum.Font.GothamBold;
	tasksHeaderLabel.TextXAlignment = Enum.TextXAlignment.Left;
	tasksHeaderLabel.Parent = tasksHeaderRow;

	const tasksProgressHeader = new Instance("TextLabel");
	tasksProgressHeader.Size = new UDim2(0.25, 0, 1, 0);
	tasksProgressHeader.Position = new UDim2(0.6, 0, 0, 0);
	tasksProgressHeader.BackgroundTransparency = 1;
	tasksProgressHeader.Text = "Progress";
	tasksProgressHeader.TextColor3 = C.label;
	tasksProgressHeader.TextSize = 9;
	tasksProgressHeader.Font = Enum.Font.GothamBold;
	tasksProgressHeader.TextXAlignment = Enum.TextXAlignment.Center;
	tasksProgressHeader.Parent = tasksHeaderRow;

	const tasksActionsHeader = new Instance("TextLabel");
	tasksActionsHeader.Size = new UDim2(0.15, 0, 1, 0);
	tasksActionsHeader.Position = new UDim2(0.85, 0, 0, 0);
	tasksActionsHeader.BackgroundTransparency = 1;
	tasksActionsHeader.Text = "Actions";
	tasksActionsHeader.TextColor3 = C.label;
	tasksActionsHeader.TextSize = 9;
	tasksActionsHeader.Font = Enum.Font.GothamBold;
	tasksActionsHeader.TextXAlignment = Enum.TextXAlignment.Right;
	tasksActionsHeader.Parent = tasksHeaderRow;

	tasksList = new Instance("ScrollingFrame");
	tasksList.Size = new UDim2(1, 0, 1, -60);
	tasksList.Position = new UDim2(0, 0, 0, 26);
	tasksList.BackgroundColor3 = C.surfaceAlt;
	tasksList.BorderSizePixel = 0;
	tasksList.ScrollBarThickness = 3;
	tasksList.ScrollBarImageColor3 = C.subtle;
	tasksList.CanvasSize = new UDim2(0, 0, 0, 0);
	tasksList.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	tasksList.Parent = tasksPanel;

	const tasksListCorner = new Instance("UICorner");
	tasksListCorner.CornerRadius = CORNER;
	tasksListCorner.Parent = tasksList;

	const tasksListLayout = new Instance("UIListLayout");
	tasksListLayout.Padding = new UDim(0, 4);
	tasksListLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	tasksListLayout.Parent = tasksList;

	const tasksEmptyLabel = new Instance("TextLabel");
	tasksEmptyLabel.Size = new UDim2(1, 0, 0, 40);
	tasksEmptyLabel.BackgroundTransparency = 1;
	tasksEmptyLabel.Text = "No tasks in queue. Direct commands will create tasks.";
	tasksEmptyLabel.TextColor3 = C.muted;
	tasksEmptyLabel.TextSize = 9;
	tasksEmptyLabel.Font = Enum.Font.GothamMedium;
	tasksEmptyLabel.Parent = tasksList;

	const logPanel = new Instance("Frame");
	logPanel.Size = new UDim2(1, 0, 0, 340);
	logPanel.BackgroundTransparency = 1;
	logPanel.LayoutOrder = 8;
	logPanel.Visible = true;
	logPanel.Parent = card;

	createRowLabel(logPanel, "Real-time Agent Log");

	const logFilterRow = new Instance("Frame");
	logFilterRow.Size = new UDim2(1, 0, 0, 24);
	logFilterRow.BackgroundTransparency = 1;
	logFilterRow.Parent = logPanel;

	const logFilterLayout = new Instance("UIGridLayout");
	logFilterLayout.CellSize = new UDim2(0.25, -4, 0, 20);
	logFilterLayout.CellPadding = new UDim2(0, 4, 0, 4);
	logFilterLayout.Parent = logFilterRow;

	const logFilterDebugBtn = createTextButton(logFilterRow, "Debug ON", new UDim2(0, 0, 0, 0), 1);
	const logFilterInfoBtn = createTextButton(logFilterRow, "Info ON", new UDim2(0, 0, 0, 0), 2);
	const logFilterWarnBtn = createTextButton(logFilterRow, "Warn ON", new UDim2(0, 0, 0, 0), 3);
	const logFilterErrorBtn = createTextButton(logFilterRow, "Error ON", new UDim2(0, 0, 0, 0), 4);

	logList = new Instance("ScrollingFrame");
	logList.Size = new UDim2(1, 0, 1, -54);
	logList.Position = new UDim2(0, 0, 0, 28);
	logList.BackgroundColor3 = C.surfaceAlt;
	logList.BorderSizePixel = 0;
	logList.ScrollBarThickness = 3;
	logList.ScrollBarImageColor3 = C.subtle;
	logList.CanvasSize = new UDim2(0, 0, 0, 0);
	logList.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	logList.Parent = logPanel;

	const logListCorner = new Instance("UICorner");
	logListCorner.CornerRadius = CORNER;
	logListCorner.Parent = logList;

	const logListLayout = new Instance("UIListLayout");
	logListLayout.Padding = new UDim(0, 2);
	logListLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	logListLayout.Parent = logList;

	commandsPanel = new Instance("Frame");
	commandsPanel.Size = new UDim2(1, 0, 0, 340);
	commandsPanel.BackgroundTransparency = 1;
	commandsPanel.LayoutOrder = 8;
	commandsPanel.Visible = true;
	commandsPanel.Parent = card;

	createRowLabel(commandsPanel, "Direct Commands");

	const commandsDescLabel = new Instance("TextLabel");
	commandsDescLabel.Size = new UDim2(1, 0, 0, 22);
	commandsDescLabel.BackgroundTransparency = 1;
	commandsDescLabel.Text = "Execute commands directly from Studio without external chat.";
	commandsDescLabel.TextColor3 = C.muted;
	commandsDescLabel.TextSize = 9;
	commandsDescLabel.Font = Enum.Font.GothamMedium;
	commandsDescLabel.TextWrapped = true;
	commandsDescLabel.TextXAlignment = Enum.TextXAlignment.Left;
	commandsDescLabel.Parent = commandsPanel;

	commandsList = new Instance("Frame");
	commandsList.Size = new UDim2(1, 0, 1, -90);
	commandsList.Position = new UDim2(0, 0, 0, 26);
	commandsList.BackgroundTransparency = 1;
	commandsList.Parent = commandsPanel;

	const commandsListLayout = new Instance("UIGridLayout");
	commandsListLayout.CellSize = new UDim2(0.5, -4, 0, 44);
	commandsListLayout.CellPadding = new UDim2(0, 4, 0, 4);
	commandsListLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	commandsListLayout.Parent = commandsList;

	const settingsPanel = new Instance("Frame");
	settingsPanel.Size = new UDim2(1, 0, 0, 260);
	settingsPanel.BackgroundTransparency = 1;
	settingsPanel.LayoutOrder = 9;
	settingsPanel.Visible = false;
	settingsPanel.Parent = card;

	const settingsLayout = new Instance("UIListLayout");
	settingsLayout.Padding = new UDim(0, 6);
	settingsLayout.Parent = settingsPanel;

	createRowLabel(settingsPanel, "Agent settings")

	const parallelRow = new Instance("Frame");
	parallelRow.Size = new UDim2(1, 0, 0, 24);
	parallelRow.BackgroundTransparency = 1;
	parallelRow.Parent = settingsPanel;

	const parallelLabel = new Instance("TextLabel");
	parallelLabel.Size = new UDim2(0.55, 0, 1, 0);
	parallelLabel.BackgroundTransparency = 1;
	parallelLabel.Text = "Parallel agents";
	parallelLabel.TextColor3 = C.label;
	parallelLabel.TextSize = 10;
	parallelLabel.Font = Enum.Font.GothamSemibold;
	parallelLabel.TextXAlignment = Enum.TextXAlignment.Left;
	parallelLabel.Parent = parallelRow;

	const minusBtn = createTextButton(parallelRow, "-", new UDim2(0, 22, 0, 22));
	minusBtn.Position = new UDim2(1, -88, 0, 1);
	const parallelValue = new Instance("TextLabel");
	parallelValue.Size = new UDim2(0, 36, 1, 0);
	parallelValue.Position = new UDim2(1, -62, 0, 0);
	parallelValue.BackgroundTransparency = 1;
	parallelValue.TextColor3 = C.label;
	parallelValue.TextSize = 10;
	parallelValue.Font = Enum.Font.GothamBold;
	parallelValue.TextXAlignment = Enum.TextXAlignment.Center;
	parallelValue.Parent = parallelRow;
	const plusBtn = createTextButton(parallelRow, "+", new UDim2(0, 22, 0, 22));
	plusBtn.Position = new UDim2(1, -24, 0, 1);

	const presetRow = new Instance("Frame");
	presetRow.Size = new UDim2(1, 0, 0, 24);
	presetRow.BackgroundTransparency = 1;
	presetRow.Parent = settingsPanel;

	const presetLabel = new Instance("TextLabel");
	presetLabel.Size = new UDim2(0.55, 0, 1, 0);
	presetLabel.BackgroundTransparency = 1;
	presetLabel.Text = "Team preset";
	presetLabel.TextColor3 = C.label;
	presetLabel.TextSize = 10;
	presetLabel.Font = Enum.Font.GothamSemibold;
	presetLabel.TextXAlignment = Enum.TextXAlignment.Left;
	presetLabel.Parent = presetRow;

	const presetButton = createTextButton(presetRow, "Balanced", new UDim2(0, 132, 0, 22));
	presetButton.Position = new UDim2(1, -132, 0, 1);

	function createToggleRow(parent: Frame, labelText: string): [Frame, TextButton] {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 24);
		row.BackgroundTransparency = 1;
		row.Parent = parent;

		const label = new Instance("TextLabel");
		label.Size = new UDim2(0.75, 0, 1, 0);
		label.BackgroundTransparency = 1;
		label.Text = labelText;
		label.TextColor3 = C.label;
		label.TextSize = 10;
		label.Font = Enum.Font.GothamSemibold;
		label.TextXAlignment = Enum.TextXAlignment.Left;
		label.Parent = row;

		const toggle = createTextButton(row, "OFF", new UDim2(0, 54, 0, 22));
		toggle.Position = new UDim2(1, -54, 0, 1);
		return [row, toggle];
	}

	const [, lightToggle] = createToggleRow(settingsPanel, "Use light model");
	const [, reviewerLightToggle] = createToggleRow(settingsPanel, "Reviewer light mode");
	const [, qaLightToggle] = createToggleRow(settingsPanel, "Q&A light mode");
	const [, mappingToggle] = createToggleRow(settingsPanel, "Use structure mapping");
	const [, autoPortToggle] = createToggleRow(settingsPanel, "Auto discover port");
	const [, verboseToggle] = createToggleRow(settingsPanel, "Verbose activity");

	settingsControls = {
		parallelValue,
		teamPresetButton: presetButton,
		lightToggle,
		reviewerLightToggle,
		qaLightToggle,
		mappingToggle,
		autoPortToggle,
		verboseToggle,
	};

	createRowLabel(settingsPanel, "Agent swarm (MCP orchestrator)");

	const orchestratorRow = new Instance("Frame");
	orchestratorRow.Size = new UDim2(1, 0, 0, 24);
	orchestratorRow.BackgroundTransparency = 1;
	orchestratorRow.Parent = settingsPanel;

	const orchestratorLabel = new Instance("TextLabel");
	orchestratorLabel.Size = new UDim2(0.6, 0, 1, 0);
	orchestratorLabel.BackgroundTransparency = 1;
	orchestratorLabel.Text = "Enable orchestrator";
	orchestratorLabel.TextColor3 = C.label;
	orchestratorLabel.TextSize = 10;
	orchestratorLabel.Font = Enum.Font.GothamSemibold;
	orchestratorLabel.TextXAlignment = Enum.TextXAlignment.Left;
	orchestratorLabel.Parent = orchestratorRow;

	const orchestratorToggleBtn = createTextButton(orchestratorRow, "OFF", new UDim2(0, 54, 0, 22));
	orchestratorToggleBtn.Position = new UDim2(1, -54, 0, 1);
	settingsControls.orchestratorToggle = orchestratorToggleBtn;

	const agentTeamsRow = new Instance("Frame");
	agentTeamsRow.Size = new UDim2(1, 0, 0, 90);
	agentTeamsRow.BackgroundTransparency = 1;
	agentTeamsRow.Parent = settingsPanel;

	const agentTeamsGrid = new Instance("UIGridLayout");
	agentTeamsGrid.CellSize = new UDim2(0.333, -4, 0, 42);
	agentTeamsGrid.CellPadding = new UDim2(0, 4, 0, 4);
	agentTeamsGrid.Parent = agentTeamsRow;

	function createAgentTeamCard(parent: Instance, teamType: "claude" | "codex" | "gemini", label: string, color: Color3): Frame {
		const card = new Instance("Frame");
		card.Size = new UDim2(0, 0, 0, 0);
		card.BackgroundColor3 = C.surfaceAlt;
		card.BorderSizePixel = 0;
		card.Parent = parent;

		const corner = new Instance("UICorner");
		corner.CornerRadius = CORNER;
		corner.Parent = card;

		const stroke = new Instance("UIStroke");
		stroke.Color = C.border;
		stroke.Thickness = 1;
		stroke.Parent = card;

		const cardLayout = new Instance("UIListLayout");
		cardLayout.Padding = new UDim(0, 2);
		cardLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		cardLayout.Parent = card;

		const header = new Instance("TextLabel");
		header.Size = new UDim2(1, 0, 0, 16);
		header.BackgroundTransparency = 1;
		header.Text = label;
		header.TextColor3 = color;
		header.TextSize = 9;
		header.Font = Enum.Font.GothamBold;
		header.TextXAlignment = Enum.TextXAlignment.Left;
		header.Parent = card;

		const statusRow = new Instance("Frame");
		statusRow.Size = new UDim2(1, 0, 0, 18);
		statusRow.BackgroundTransparency = 1;
		statusRow.Parent = card;

		const statusLabel = new Instance("TextLabel");
		statusLabel.Size = new UDim2(0.5, 0, 1, 0);
		statusLabel.BackgroundTransparency = 1;
		statusLabel.Text = "Enabled";
		statusLabel.TextColor3 = C.muted;
		statusLabel.TextSize = 8;
		statusLabel.Font = Enum.Font.GothamMedium;
		statusLabel.TextXAlignment = Enum.TextXAlignment.Left;
		statusLabel.Parent = statusRow;

		const toggleBtn = createTextButton(statusRow, "ON", new UDim2(0, 36, 0, 16));
		toggleBtn.Name = teamType + "Toggle";
		toggleBtn.TextSize = 8;

		return card;
	}

	const claudeCard = createAgentTeamCard(agentTeamsRow, "claude", "Claude", C.blue);
	const codexCard = createAgentTeamCard(agentTeamsRow, "codex", "Codex", C.green);
	const geminiCard = createAgentTeamCard(agentTeamsRow, "gemini", "Gemini", C.yellow);

	settingsControls.claudeToggle = claudeCard.FindFirstChild("claudeToggle") as TextButton;
	settingsControls.codexToggle = codexCard.FindFirstChild("codexToggle") as TextButton;
	settingsControls.geminiToggle = geminiCard.FindFirstChild("geminiToggle") as TextButton;

	viewPanels.set("overview", overviewPanel);
	viewPanels.set("activity", activityPanel);
	viewPanels.set("agents", agentsPanel);
	viewPanels.set("mission", missionPanel);
	viewPanels.set("chat", chatPanel);
	viewPanels.set("settings", settingsPanel);

	overviewBtn.Activated.Connect(() => setActiveView("overview"));
	activityBtn.Activated.Connect(() => setActiveView("activity"));
	agentsBtn.Activated.Connect(() => setActiveView("agents"));
	missionBtn.Activated.Connect(() => setActiveView("mission"));
	chatBtn.Activated.Connect(() => setActiveView("chat"));
	settingsBtn.Activated.Connect(() => setActiveView("settings"));

	pauseAllBtn.Activated.Connect(() => {
		pushActivity("info", "Agent Control", "Pause All agents requested");
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			task.spawn(() => {
				pcall(() => {
					HttpService.RequestAsync({
						Url: `${conn.serverUrl}/api/agent/control`,
						Method: "POST",
						Headers: { "Content-Type": "application/json" },
						Body: HttpService.JSONEncode({ action: "pause", agentId: "default" }),
					});
				});
			});
		}
		State.updateAgentSettings({ agentPauseEnabled: true });
	});
	resumeAllBtn.Activated.Connect(() => {
		pushActivity("info", "Agent Control", "Resume All agents requested");
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			task.spawn(() => {
				pcall(() => {
					HttpService.RequestAsync({
						Url: `${conn.serverUrl}/api/agent/control`,
						Method: "POST",
						Headers: { "Content-Type": "application/json" },
						Body: HttpService.JSONEncode({ action: "resume", agentId: "default" }),
					});
				});
			});
		}
		State.updateAgentSettings({ agentPauseEnabled: false });
	});
	stopAllBtn.Activated.Connect(() => {
		pushActivity("warn", "Agent Control", "Stop All agents requested");
		const conn = State.getActiveConnection();
		if (conn && conn.isActive) {
			task.spawn(() => {
				pcall(() => {
					HttpService.RequestAsync({
						Url: `${conn.serverUrl}/api/agent/control`,
						Method: "POST",
						Headers: { "Content-Type": "application/json" },
						Body: HttpService.JSONEncode({ action: "stop", agentId: "default" }),
					});
				});
			});
		}
		State.updateAgentSettings({ agentPauseEnabled: false });
	});

	chatSendBtn.Activated.Connect(() => {
		const inputBox = chatInputBox;
		if (!inputBox) return;
		const msg = inputBox.Text;
		if (msg.size() === 0) return;
		const conn = State.getActiveConnection();
		if (!conn || !conn.isActive) {
			pushActivity("error", "Chat Error", "Not connected to MCP server");
			return;
		}
		inputBox.Text = "";
		task.spawn(() => {
			const [ok, result] = pcall(() => {
				return HttpService.RequestAsync({
					Url: `${conn.serverUrl}/api/agent/chat`,
					Method: "POST",
					Headers: { "Content-Type": "application/json" },
					Body: HttpService.JSONEncode({
						message: msg,
						agentId: "default",
						threadId: State.getActiveThreadId() || undefined,
					}),
				});
			});
			if (ok && result && result.Success) {
				const [decOk, data] = pcall(() => HttpService.JSONDecode(result.Body));
				if (decOk && data) {
					const resp = data as { success?: boolean; response?: string; threadId?: string };
					if (resp.success && resp.threadId) {
						State.setActiveThreadId(resp.threadId);
						if (resp.response) {
							const assistantMsg = {
								id: `msg_${tick()}_${math.random() * 99999}`,
								role: "assistant" as const,
								content: resp.response,
								timestamp: tick(),
							};
							State.addAgentChatMessage(resp.threadId, assistantMsg);
						}
						rebuildChatMessages();
					}
				}
				pushActivity("success", "Chat sent", "Message processed by agent");
			} else {
				pushActivity("error", "Chat failed", "Could not send message to agent");
			}
		});
	});

	chatClearBtn.Activated.Connect(() => {
		const threadId = State.getActiveThreadId();
		if (threadId && threadId !== "") {
			const messages = State.getAgentChatMessages(threadId);
			while (messages.size() > 0) {
				messages.remove(0);
			}
		}
		pushActivity("info", "Chat cleared", "Conversation cleared");
	});

	refreshMapBtn.Activated.Connect(() => {
		pushActivity("info", "Quick action", "Refresh structure map requested");
		if (quickActionHandlers.onRefreshStructureMap) quickActionHandlers.onRefreshStructureMap();
	});
	discoverPortBtn.Activated.Connect(() => {
		pushActivity("info", "Quick action", "Port discovery requested");
		if (quickActionHandlers.onDiscoverPort) quickActionHandlers.onDiscoverPort();
	});
	readyPingBtn.Activated.Connect(() => {
		pushActivity("info", "Quick action", "Manual MCP sync requested");
		if (quickActionHandlers.onSendReadyHandshake) quickActionHandlers.onSendReadyHandshake();
	});
	clearFeedBtn.Activated.Connect(() => {
		if (quickActionHandlers.onClearActivity) quickActionHandlers.onClearActivity();
		else State.clearActivity();
		rebuildActivityRows();
	});
	activityFilterReadBtn?.Activated.Connect(() => {
		activityFilters.read = !activityFilters.read;
		updateActivityFilterButtons();
		rebuildActivityRows();
	});
	activityFilterWriteBtn?.Activated.Connect(() => {
		activityFilters.write = !activityFilters.write;
		updateActivityFilterButtons();
		rebuildActivityRows();
	});
	activityFilterErrorBtn?.Activated.Connect(() => {
		activityFilters.error = !activityFilters.error;
		updateActivityFilterButtons();
		rebuildActivityRows();
	});
	activityFilterStructureBtn?.Activated.Connect(() => {
		activityFilters.structure = !activityFilters.structure;
		updateActivityFilterButtons();
		rebuildActivityRows();
	});
	activityGroupBtn?.Activated.Connect(() => {
		activityGroupedByPath = !activityGroupedByPath;
		updateActivityFilterButtons();
		rebuildActivityRows();
	});

	minusBtn.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ parallelAgents: math.max(1, current.parallelAgents - 1) });
	});
	plusBtn.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ parallelAgents: math.min(4, current.parallelAgents + 1) });
	});
	presetButton.Activated.Connect(() => {
		const current = State.getPluginSettings();
		const nextPreset: PluginSettings["teamPreset"] =
			current.teamPreset === "balanced"
				? "throughput"
				: current.teamPreset === "throughput"
					? "tokenSaver"
					: "balanced";
		commitSettings({ teamPreset: nextPreset });
	});
	lightToggle.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ useLightModel: !current.useLightModel });
	});
	reviewerLightToggle.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ reviewerLightMode: !current.reviewerLightMode });
	});
	qaLightToggle.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ qaLightMode: !current.qaLightMode });
	});
	mappingToggle.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ useStructureMapping: !current.useStructureMapping });
	});
	autoPortToggle.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ autoPortDiscovery: !current.autoPortDiscovery });
	});
	verboseToggle.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ verboseActivity: !current.verboseActivity });
	});
	settingsControls.orchestratorToggle?.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ orchestratorEnabled: !current.orchestratorEnabled });
	});
	settingsControls.claudeToggle?.Activated.Connect(() => {
		const current = State.getPluginSettings();
		const teams = { ...current.agentTeams };
		teams.claude = { ...teams.claude, enabled: !teams.claude.enabled };
		commitSettings({ agentTeams: teams });
	});
	settingsControls.codexToggle?.Activated.Connect(() => {
		const current = State.getPluginSettings();
		const teams = { ...current.agentTeams };
		teams.codex = { ...teams.codex, enabled: !teams.codex.enabled };
		commitSettings({ agentTeams: teams });
	});
	settingsControls.geminiToggle?.Activated.Connect(() => {
		const current = State.getPluginSettings();
		const teams = { ...current.agentTeams };
		teams.gemini = { ...teams.gemini, enabled: !teams.gemini.enabled };
		commitSettings({ agentTeams: teams });
	});

	const claudeSelectBtn = claudeTeamCard.FindFirstChild("claudeSelect") as TextButton;
	const codexSelectBtn = codexTeamCard.FindFirstChild("codexSelect") as TextButton;
	const geminiSelectBtn = geminiTeamCard.FindFirstChild("geminiSelect") as TextButton;

	claudeSelectBtn?.Activated.Connect(() => {
		const team = State.getTeamContext();
		const isSelected = team.selectedAgents.find((a) => a === "claude") !== undefined;
		const selected = isSelected
			? team.selectedAgents.filter((a) => a !== "claude")
			: [...team.selectedAgents, "claude"];
		State.setTeamContext({ selectedAgents: selected });
		pushActivity("info", "Team Selection", `Claude ${isSelected ? "deselected" : "selected"}`);
	});
	codexSelectBtn?.Activated.Connect(() => {
		const team = State.getTeamContext();
		const isSelected = team.selectedAgents.find((a) => a === "codex") !== undefined;
		const selected = isSelected
			? team.selectedAgents.filter((a) => a !== "codex")
			: [...team.selectedAgents, "codex"];
		State.setTeamContext({ selectedAgents: selected });
		pushActivity("info", "Team Selection", `Codex ${isSelected ? "deselected" : "selected"}`);
	});
	geminiSelectBtn?.Activated.Connect(() => {
		const team = State.getTeamContext();
		const isSelected = team.selectedAgents.find((a) => a === "gemini") !== undefined;
		const selected = isSelected
			? team.selectedAgents.filter((a) => a !== "gemini")
			: [...team.selectedAgents, "gemini"];
		State.setTeamContext({ selectedAgents: selected });
		pushActivity("info", "Team Selection", `Gemini ${isSelected ? "deselected" : "selected"}`);
	});

	elements = {
		screenGui,
		mainFrame,
		contentFrame,
		statusLabel,
		detailStatusLabel,
		statusIndicator,
		statusPulse,
		statusText,
		connectButton,
		connectStroke,
		urlInput,
		step1Dot,
		step1Label,
		step2Dot,
		step2Label,
		step3Dot,
		step3Label,
		troubleshootLabel,
		updateBanner,
		updateBannerText,
		tabBar,
	};

	refreshTabBar();
	applySettingsUI(State.getPluginSettings());
	updateActivityFilterButtons();
	setActiveView("overview");
	refreshAgentMappingSection();
	rebuildStructureExplorerList();
	updateDiagnosticsPanel({
		serverReachable: false,
		serverMessage: "No diagnostics yet",
		bridgeStatus: "unknown",
		pluginStatus: "unknown",
		mcpStatus: "unknown",
		endpointSupport: "unknown",
		cacheStatus: "unknown",
		writeQueueStatus: "unknown",
		lastErrorSummary: "none",
		lastErrorCause: "Waiting for first diagnostics poll.",
		lastUpdatedAtText: "never",
	});
	pushActivity("info", "Plugin ready", "UI initialized and settings loaded");
}

function updateUIState() {
	const conn = State.getActiveConnection();
	if (!conn) return;
	const el = elements;

	const phase = deriveConnectionPhase(conn);

	if (phase === "connected") {
		el.statusLabel.Text = "Connected";
		el.statusLabel.TextColor3 = C.green;
		el.statusIndicator.BackgroundColor3 = C.green;
		el.statusPulse.BackgroundColor3 = C.green;
		el.statusText.Text = "ONLINE";
		el.detailStatusLabel.Text = "HTTP: OK  MCP: OK";
		el.detailStatusLabel.TextColor3 = C.green;
		stopPulseAnimation();

		el.step1Dot.BackgroundColor3 = C.green;
		el.step1Label.Text = "HTTP server (OK)";
		el.step2Dot.BackgroundColor3 = C.green;
		el.step2Label.Text = "MCP bridge (OK)";
		el.step3Dot.BackgroundColor3 = C.green;
		el.step3Label.Text = "Commands (OK)";
		conn.mcpWaitStartTime = undefined;
		el.troubleshootLabel.Visible = false;

		if (!buttonHover) setButtonDisconnect(el.connectButton, el.connectStroke);
		el.urlInput.TextEditable = false;
		el.urlInput.BackgroundColor3 = C.surface;
		return;
	}

	if (phase === "waiting") {
		el.statusLabel.Text = "Waiting for MCP server";
		el.statusLabel.TextColor3 = C.yellow;
		el.statusIndicator.BackgroundColor3 = C.yellow;
		el.statusPulse.BackgroundColor3 = C.yellow;
		el.statusText.Text = "WAITING";
		el.detailStatusLabel.Text = "HTTP: OK  MCP: ...";
		el.detailStatusLabel.TextColor3 = C.yellow;
		startPulseAnimation();

		el.step1Dot.BackgroundColor3 = C.green;
		el.step1Label.Text = "HTTP server (OK)";
		el.step2Dot.BackgroundColor3 = C.yellow;
		el.step2Label.Text = "MCP bridge (waiting...)";
		el.step3Dot.BackgroundColor3 = C.yellow;
		el.step3Label.Text = "Commands (waiting...)";

		if (conn.mcpWaitStartTime === undefined) {
			conn.mcpWaitStartTime = tick();
		}
		el.troubleshootLabel.Visible = tick() - (conn.mcpWaitStartTime ?? tick()) > 8;

		if (!buttonHover) setButtonDisconnect(el.connectButton, el.connectStroke);
		el.urlInput.TextEditable = false;
		el.urlInput.BackgroundColor3 = C.surface;
		return;
	}

	if (phase === "error") {
		el.statusLabel.Text = "Server unavailable";
		el.statusLabel.TextColor3 = C.red;
		el.statusIndicator.BackgroundColor3 = C.red;
		el.statusPulse.BackgroundColor3 = C.red;
		el.statusText.Text = "ERROR";
		el.detailStatusLabel.Text = "HTTP: X  MCP: X";
		el.detailStatusLabel.TextColor3 = C.red;
		stopPulseAnimation();

		el.step1Dot.BackgroundColor3 = C.red;
		el.step1Label.Text = "HTTP server (error)";
		el.step2Dot.BackgroundColor3 = C.red;
		el.step2Label.Text = "MCP bridge (error)";
		el.step3Dot.BackgroundColor3 = C.red;
		el.step3Label.Text = "Commands (error)";
		conn.mcpWaitStartTime = undefined;
		el.troubleshootLabel.Visible = false;

		if (!buttonHover) setButtonDisconnect(el.connectButton, el.connectStroke);
		el.urlInput.TextEditable = false;
		el.urlInput.BackgroundColor3 = C.surface;
		return;
	}

	if (phase === "retry") {
		const waitTime = math.ceil(conn.currentRetryDelay);
		el.statusLabel.Text = `Retrying (${waitTime}s)`;
		el.statusLabel.TextColor3 = C.yellow;
		el.statusIndicator.BackgroundColor3 = C.yellow;
		el.statusPulse.BackgroundColor3 = C.yellow;
		el.statusText.Text = "RETRY";
		el.detailStatusLabel.Text = "HTTP: ...  MCP: ...";
		el.detailStatusLabel.TextColor3 = C.yellow;
		startPulseAnimation();

		el.step1Dot.BackgroundColor3 = C.yellow;
		el.step1Label.Text = "HTTP server (retrying...)";
		el.step2Dot.BackgroundColor3 = C.yellow;
		el.step2Label.Text = "MCP bridge (retrying...)";
		el.step3Dot.BackgroundColor3 = C.yellow;
		el.step3Label.Text = "Commands (retrying...)";
		conn.mcpWaitStartTime = undefined;
		el.troubleshootLabel.Visible = false;

		if (!buttonHover) setButtonDisconnect(el.connectButton, el.connectStroke);
		el.urlInput.TextEditable = false;
		el.urlInput.BackgroundColor3 = C.surface;
		return;
	}

	if (phase === "connecting") {
		el.statusLabel.Text = "Connecting...";
		el.statusLabel.TextColor3 = C.yellow;
		el.statusIndicator.BackgroundColor3 = C.yellow;
		el.statusPulse.BackgroundColor3 = C.yellow;
		el.statusText.Text = "CONNECTING";
		el.detailStatusLabel.Text = conn.consecutiveFailures === 0 ? "..." : "HTTP: X  MCP: X";
		el.detailStatusLabel.TextColor3 = C.muted;
		startPulseAnimation();

		el.step1Dot.BackgroundColor3 = C.yellow;
		el.step1Label.Text = "HTTP server (connecting...)";
		el.step2Dot.BackgroundColor3 = C.yellow;
		el.step2Label.Text = "MCP bridge (connecting...)";
		el.step3Dot.BackgroundColor3 = C.yellow;
		el.step3Label.Text = "Commands (connecting...)";
		conn.mcpWaitStartTime = undefined;
		el.troubleshootLabel.Visible = false;

		if (!buttonHover) setButtonDisconnect(el.connectButton, el.connectStroke);
		el.urlInput.TextEditable = false;
		el.urlInput.BackgroundColor3 = C.surface;
		return;
	}

	el.statusLabel.Text = "Disconnected";
	el.statusLabel.TextColor3 = C.muted;
	el.statusIndicator.BackgroundColor3 = C.red;
	el.statusPulse.BackgroundColor3 = C.red;
	el.statusText.Text = "OFFLINE";
	el.detailStatusLabel.Text = "";
	el.detailStatusLabel.TextColor3 = C.muted;
	stopPulseAnimation();

	el.step1Dot.BackgroundColor3 = C.gray;
	el.step1Label.Text = "HTTP server";
	el.step2Dot.BackgroundColor3 = C.gray;
	el.step2Label.Text = "MCP bridge";
	el.step3Dot.BackgroundColor3 = C.gray;
	el.step3Label.Text = "Commands";
	conn.mcpWaitStartTime = undefined;
	el.troubleshootLabel.Visible = false;

	if (!buttonHover) setButtonConnect(el.connectButton, el.connectStroke);
	el.urlInput.TextEditable = true;
	el.urlInput.BackgroundColor3 = C.surfaceAlt;
}

function updateTabDot(connIndex: number) {
	const tb = tabButtons.get(connIndex);
	if (tb) {
		tb.dot.BackgroundColor3 = getStatusDotColor(connIndex);
	}
}

function setQuickActions(handlers: QuickActionHandlers) {
	quickActionHandlers = handlers;
}

function setSettingsChangedHandler(handler: SettingsChangedHandler | undefined) {
	onSettingsChanged = handler;
}

function refreshConnectionTabs() {
	refreshTabBar();
	switchToTab(State.getActiveTabIndex());
}

function refreshStructureExplorerSection() {
	rebuildStructureExplorerList();
}

function rebuildAgentStatusPanel() {
	const summaryLabel = agentStatusSummaryLabel;
	const metricsLabel = agentMetricsLabel;
	const threadsLabel = agentThreadsLabel;
	if (!summaryLabel || !metricsLabel || !threadsLabel) return;
	const sl = summaryLabel;
	const ml = metricsLabel;
	const tl = threadsLabel;
	task.spawn(() => {
		const conn = State.getActiveConnection();
		if (!conn || !conn.isActive) {
			sl.Text = "Not connected";
			ml.Text = "Tokens: 0 in / 0 out | Latency: 0ms";
			tl.Text = "Threads: 0 | Requests: 0";
			return;
		}
		const [ok, result] = pcall(() => {
			return HttpService.RequestAsync({
				Url: `${conn.serverUrl}/api/agent/status`,
				Method: "GET",
				Headers: { "Content-Type": "application/json" },
			});
		});
		if (ok && result && result.Success) {
			const [decOk, data] = pcall(() => HttpService.JSONDecode(result.Body));
			if (decOk && data) {
				const resp = data as { agents?: Array<{ agentId: string; status: string; tokensIn: number; tokensOut: number; avgLatencyMs: number; requestCount: number; threadCount: number }>; totalTokensIn?: number; totalTokensOut?: number; activeAgentCount?: number };
				const agents = resp.agents ?? [];
				const activeCount = resp.activeAgentCount ?? agents.filter((a) => a.status === "active").size();
				sl.Text = `${activeCount} active agent${activeCount !== 1 ? "s" : ""} | ${agents.size()} total`;
				ml.Text = `Tokens: ${resp.totalTokensIn ?? 0} in / ${resp.totalTokensOut ?? 0} out`;
				tl.Text = `Threads: ${agents.size()} | Requests: ${agents.reduce((sum: number, a: { requestCount: number }) => sum + (a.requestCount ?? 0), 0)}`;
			}
		}
	});
}

function rebuildTaskList() {
	if (!tasksList) return;
	for (const child of tasksList.GetChildren()) {
		if (child.IsA("Frame")) {
			child.Destroy();
		}
	}
	taskRows.clear();
	const tasks = State.getTasks();
	if (tasks.size() === 0) {
		return;
	}
	for (const task of tasks) {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 52);
		row.BackgroundTransparency = 1;
		row.LayoutOrder = task.createdAt;
		row.Parent = tasksList;

		const statusDot = new Instance("Frame");
		statusDot.Size = new UDim2(0, 8, 0, 8);
		statusDot.Position = new UDim2(0, 4, 0, 4);
		statusDot.BackgroundColor3 =
			task.status === "completed" ? C.green :
			task.status === "failed" ? C.red :
			task.status === "running" ? C.blue :
			task.status === "cancelled" ? C.yellow : C.gray;
		statusDot.BorderSizePixel = 0;
		statusDot.Parent = row;

		const dotCorner = new Instance("UICorner");
		dotCorner.CornerRadius = new UDim(1, 0);
		dotCorner.Parent = statusDot;

		const titleLabel = new Instance("TextLabel");
		titleLabel.Size = new UDim2(0.6, -16, 0, 16);
		titleLabel.Position = new UDim2(0, 16, 0, 2);
		titleLabel.BackgroundTransparency = 1;
		titleLabel.Text = task.title;
		titleLabel.TextColor3 = C.label;
		titleLabel.TextSize = 9;
		titleLabel.Font = Enum.Font.GothamSemibold;
		titleLabel.TextXAlignment = Enum.TextXAlignment.Left;
		titleLabel.TextTruncate = Enum.TextTruncate.AtEnd;
		titleLabel.Parent = row;

		const descLabel = new Instance("TextLabel");
		descLabel.Size = new UDim2(0.6, -16, 0, 14);
		descLabel.Position = new UDim2(0, 16, 0, 18);
		descLabel.BackgroundTransparency = 1;
		descLabel.Text = task.description;
		descLabel.TextColor3 = C.muted;
		descLabel.TextSize = 8;
		descLabel.Font = Enum.Font.GothamMedium;
		descLabel.TextXAlignment = Enum.TextXAlignment.Left;
		descLabel.TextTruncate = Enum.TextTruncate.AtEnd;
		descLabel.Parent = row;

		const progressBarBg = new Instance("Frame");
		progressBarBg.Size = new UDim2(0.25, -4, 0, 8);
		progressBarBg.Position = new UDim2(0.6, 0, 0, 4);
		progressBarBg.BackgroundColor3 = C.surface;
		progressBarBg.BorderSizePixel = 0;
		progressBarBg.Parent = row;

		const progressBarCorner = new Instance("UICorner");
		progressBarCorner.CornerRadius = new UDim(1, 0);
		progressBarCorner.Parent = progressBarBg;

		const progressBar = new Instance("Frame");
		progressBar.Size = new UDim2(task.progress / 100, 0, 1, 0);
		progressBar.BackgroundColor3 =
			task.status === "completed" ? C.green :
			task.status === "failed" ? C.red :
			task.status === "running" ? C.blue : C.subtle;
		progressBar.BorderSizePixel = 0;
		progressBar.Parent = progressBarBg;

		const progressBarFillCorner = new Instance("UICorner");
		progressBarFillCorner.CornerRadius = new UDim(1, 0);
		progressBarFillCorner.Parent = progressBar;

		const progressLabel = new Instance("TextLabel");
		progressLabel.Size = new UDim2(0.25, -4, 0, 12);
		progressLabel.Position = new UDim2(0.6, 0, 0, 14);
		progressLabel.BackgroundTransparency = 1;
		progressLabel.Text = `${math.floor(task.progress)}%`;
		progressLabel.TextColor3 = C.muted;
		progressLabel.TextSize = 7;
		progressLabel.Font = Enum.Font.GothamMedium;
		progressLabel.TextXAlignment = Enum.TextXAlignment.Center;
		progressLabel.Parent = row;

		const actionsRow = new Instance("Frame");
		actionsRow.Size = new UDim2(0.15, 0, 1, 0);
		actionsRow.Position = new UDim2(0.85, 0, 0, 0);
		actionsRow.BackgroundTransparency = 1;
		actionsRow.Parent = row;

		if (task.status === "running") {
			const cancelBtn = createTextButton(actionsRow, "Cancel", new UDim2(1, 0, 0, 18));
			cancelBtn.TextSize = 8;
			cancelBtn.Activated.Connect(() => {
				State.cancelTask(task.id);
				State.addLog("warn", "plugin", `Task cancelled: ${task.title}`, task.id);
				rebuildTaskList();
			});
		} else if (task.status === "pending") {
			const runBtn = createTextButton(actionsRow, "Run", new UDim2(1, 0, 0, 18));
			runBtn.TextSize = 8;
			runBtn.BackgroundColor3 = C.surface;
			runBtn.Activated.Connect(() => {
				State.updateTask(task.id, { status: "running", progress: 0 });
				State.addLog("info", "plugin", `Task started: ${task.title}`, task.id);
				if (quickActionHandlers.onExecuteDirectCommand) {
					quickActionHandlers.onExecuteDirectCommand(task.id, task.title, {});
				}
				rebuildTaskList();
			});
		}

		taskRows.set(task.id, row);
	}
}

function rebuildLogList() {
	if (!logList) return;
	for (const child of logList.GetChildren()) {
		if (child.IsA("Frame")) {
			child.Destroy();
		}
	}
	logRows.clear();
	const logs = State.getLogs();
	for (const entry of logs) {
		if (!logFilters[entry.level]) continue;
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 28);
		row.BackgroundTransparency = 1;
		row.LayoutOrder = -entry.timestamp;
		row.Parent = logList;

		const levelDot = new Instance("Frame");
		levelDot.Size = new UDim2(0, 6, 0, 6);
		levelDot.Position = new UDim2(0, 6, 0, 6);
		levelDot.BackgroundColor3 =
			entry.level === "error" ? C.red :
			entry.level === "warn" ? C.yellow :
			entry.level === "info" ? C.blue : C.gray;
		levelDot.BorderSizePixel = 0;
		levelDot.Parent = row;

		const dotCorner = new Instance("UICorner");
		dotCorner.CornerRadius = new UDim(1, 0);
		dotCorner.Parent = levelDot;

		const sourceLabel = new Instance("TextLabel");
		sourceLabel.Size = new UDim2(0, 50, 1, 0);
		sourceLabel.Position = new UDim2(0, 16, 0, 0);
		sourceLabel.BackgroundTransparency = 1;
		sourceLabel.Text = entry.source;
		sourceLabel.TextColor3 = C.subtle;
		sourceLabel.TextSize = 8;
		sourceLabel.Font = Enum.Font.GothamMedium;
		sourceLabel.TextXAlignment = Enum.TextXAlignment.Left;
		sourceLabel.Parent = row;

		const messageLabel = new Instance("TextLabel");
		messageLabel.Size = new UDim2(1, -100, 1, 0);
		messageLabel.Position = new UDim2(0, 68, 0, 0);
		messageLabel.BackgroundTransparency = 1;
		messageLabel.Text = entry.message;
		messageLabel.TextColor3 = C.label;
		messageLabel.TextSize = 9;
		messageLabel.Font = Enum.Font.GothamMedium;
		messageLabel.TextXAlignment = Enum.TextXAlignment.Left;
		messageLabel.TextTruncate = Enum.TextTruncate.AtEnd;
		messageLabel.Parent = row;

		const timeLabel = new Instance("TextLabel");
		timeLabel.Size = new UDim2(0, 60, 1, 0);
		timeLabel.Position = new UDim2(1, -64, 0, 0);
		timeLabel.BackgroundTransparency = 1;
		timeLabel.Text = formatTime(entry.timestamp);
		timeLabel.TextColor3 = C.muted;
		timeLabel.TextSize = 8;
		timeLabel.Font = Enum.Font.GothamMedium;
		timeLabel.TextXAlignment = Enum.TextXAlignment.Right;
		timeLabel.Parent = row;

		logRows.set(entry.id, row);
	}
}

function rebuildCommandList() {
	if (!commandsList) return;
	for (const child of commandsList.GetChildren()) {
		if (child.IsA("Frame")) {
			child.Destroy();
		}
	}
	const commands = State.getDirectCommands();
	for (const cmd of commands) {
		const card = new Instance("Frame");
		card.Size = new UDim2(1, 0, 0, 0);
		card.AutomaticSize = Enum.AutomaticSize.Y;
		card.BackgroundColor3 = C.surfaceAlt;
		card.BorderSizePixel = 0;
		card.Parent = commandsList;

		const corner = new Instance("UICorner");
		corner.CornerRadius = CORNER;
		corner.Parent = card;

		const cmdLayout = new Instance("UIListLayout");
		cmdLayout.Padding = new UDim(0, 4);
		cmdLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		cmdLayout.Parent = card;

		const cmdHeader = new Instance("TextLabel");
		cmdHeader.Size = new UDim2(1, 0, 0, 14);
		cmdHeader.BackgroundTransparency = 1;
		cmdHeader.Text = cmd.name;
		cmdHeader.TextColor3 = C.label;
		cmdHeader.TextSize = 9;
		cmdHeader.Font = Enum.Font.GothamSemibold;
		cmdHeader.TextXAlignment = Enum.TextXAlignment.Left;
		cmdHeader.Parent = card;

		const cmdDesc = new Instance("TextLabel");
		cmdDesc.Size = new UDim2(1, 0, 0, 14);
		cmdDesc.BackgroundTransparency = 1;
		cmdDesc.Text = cmd.description;
		cmdDesc.TextColor3 = C.muted;
		cmdDesc.TextSize = 8;
		cmdDesc.Font = Enum.Font.GothamMedium;
		cmdDesc.TextXAlignment = Enum.TextXAlignment.Left;
		cmdDesc.Parent = card;

		const executeBtn = createTextButton(card, "Execute", new UDim2(1, 0, 0, 22));
		executeBtn.TextSize = 9;
		executeBtn.Activated.Connect(() => {
			const task = State.addTask(cmd.name, cmd.description);
			State.updateTask(task.id, { status: "running", progress: 0 });
			State.addLog("info", "plugin", `Executing command: ${cmd.name}`, task.id);
			if (quickActionHandlers.onExecuteDirectCommand) {
				quickActionHandlers.onExecuteDirectCommand(task.id, cmd.endpoint, cmd.params ?? {});
			}
			rebuildTaskList();
		});
	}
}

function registerDirectCommand(name: string, description: string, endpoint: string, params?: Record<string, unknown>) {
	State.registerDirectCommand(name, description, endpoint, params);
	if (commandsList) {
		rebuildCommandList();
	}
}

function onTaskUpdate(update: { taskId: string; status: string; progress: number; message?: string }) {
	const task = State.getTask(update.taskId);
	if (!task) return;
	State.updateTask(update.taskId, {
		status: update.status as any,
		progress: update.progress,
	});
	State.addLog(
		update.status === "completed" ? "info" :
		update.status === "failed" ? "error" : "debug",
		"bridge",
		update.message ?? `Task ${update.taskId}: ${update.status} (${update.progress}%)`,
		update.taskId
	);
	if (activeView === "tasks") {
		rebuildTaskList();
	}
	if (activeView === "log") {
		rebuildLogList();
	}
}

function rebuildChatMessages() {
	if (!chatMessagesList) return;
	for (const child of chatMessagesList.GetChildren()) {
		if (child.IsA("Frame")) {
			child.Destroy();
		}
	}
	const threadId = State.getActiveThreadId();
	if (!threadId || threadId === "") {
		const emptyLabel = new Instance("TextLabel");
		emptyLabel.Size = new UDim2(1, 0, 0, 22);
		emptyLabel.BackgroundTransparency = 1;
		emptyLabel.Text = "No active thread. Start a conversation first.";
		emptyLabel.TextColor3 = C.muted;
		emptyLabel.TextSize = 10;
		emptyLabel.Font = Enum.Font.GothamMedium;
		emptyLabel.TextXAlignment = Enum.TextXAlignment.Left;
		emptyLabel.Parent = chatMessagesList;
		return;
	}
	const messages = State.getAgentChatMessages(threadId);
	if (messages.size() === 0) {
		const emptyLabel = new Instance("TextLabel");
		emptyLabel.Size = new UDim2(1, 0, 0, 22);
		emptyLabel.BackgroundTransparency = 1;
		emptyLabel.Text = "No messages in this thread.";
		emptyLabel.TextColor3 = C.muted;
		emptyLabel.TextSize = 10;
		emptyLabel.Font = Enum.Font.GothamMedium;
		emptyLabel.TextXAlignment = Enum.TextXAlignment.Left;
		emptyLabel.Parent = chatMessagesList;
		return;
	}
	for (const msg of messages) {
		const msgFrame = new Instance("Frame");
		msgFrame.Size = new UDim2(1, 0, 0, 0);
		msgFrame.AutomaticSize = Enum.AutomaticSize.Y;
		msgFrame.BackgroundTransparency = 1;
		msgFrame.LayoutOrder = msg.timestamp;
		msgFrame.Parent = chatMessagesList;

		const isUser = msg.role === "user";
		const msgBubble = new Instance("TextLabel");
		msgBubble.Size = new UDim2(0.75, 0, 0, 0);
		msgBubble.AutomaticSize = Enum.AutomaticSize.Y;
		msgBubble.Position = isUser ? new UDim2(1, 0, 0, 0) : new UDim2(0, 0, 0, 0);
		msgBubble.AnchorPoint = isUser ? new Vector2(1, 0) : new Vector2(0, 0);
		msgBubble.BackgroundColor3 = isUser ? C.blue : C.surface;
		msgBubble.BackgroundTransparency = 0.1;
		msgBubble.BorderSizePixel = 0;
		msgBubble.Text = msg.content;
		msgBubble.TextColor3 = C.label;
		msgBubble.TextSize = 9;
		msgBubble.Font = Enum.Font.GothamMedium;
		msgBubble.TextWrapped = true;
		msgBubble.TextXAlignment = isUser ? Enum.TextXAlignment.Right : Enum.TextXAlignment.Left;
		msgBubble.TextYAlignment = Enum.TextYAlignment.Top;
		msgBubble.Parent = msgFrame;

		const corner = new Instance("UICorner");
		corner.CornerRadius = CORNER;
		corner.Parent = msgBubble;

		const padding = new Instance("UIPadding");
		padding.PaddingLeft = new UDim(0, 8);
		padding.PaddingRight = new UDim(0, 8);
		padding.PaddingTop = new UDim(0, 4);
		padding.PaddingBottom = new UDim(0, 4);
		padding.Parent = msgBubble;

		const timeLabel = new Instance("TextLabel");
		timeLabel.Size = new UDim2(1, 0, 0, 12);
		timeLabel.BackgroundTransparency = 1;
		const date = DateTime.fromUnixTimestamp(math.floor(msg.timestamp));
		timeLabel.Text = date.FormatLocalTime("HH:mm:ss", "en-us");
		timeLabel.TextColor3 = C.muted;
		timeLabel.TextSize = 8;
		timeLabel.Font = Enum.Font.GothamMedium;
		timeLabel.TextXAlignment = isUser ? Enum.TextXAlignment.Right : Enum.TextXAlignment.Left;
		timeLabel.Parent = msgFrame;
	}
}

function refreshAgentSection() {
	rebuildAgentStatusPanel();
}

function refreshChatSection() {
	rebuildChatMessages();
}

export = {
	elements: undefined as unknown as UIElements,
	init,
	updateUIState,
	updateTabDot,
	stopPulseAnimation,
	startPulseAnimation,
	pushActivity,
	setQuickActions,
	setSettingsChangedHandler,
	refreshConnectionTabs,
	refreshAgentMappingSection,
	refreshStructureExplorerSection,
	updateDiagnosticsPanel,
	refreshAgentSection,
	refreshChatSection,
	registerDirectCommand,
	inferProbableCause,
	getElements: () => elements,
	refreshMissionPanel,
};
