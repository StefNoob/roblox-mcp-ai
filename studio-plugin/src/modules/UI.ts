import { TweenService } from "@rbxts/services";
import State from "./State";
import { ActivityEntry, ActivityLevel, Connection, PluginSettings } from "../types";

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
}

type SettingsChangedHandler = (settings: PluginSettings) => void;
type ViewName = "overview" | "activity" | "settings";

const SETTINGS_KEY = "mcp_plugin_settings_v2";
const TWEEN_QUICK = new TweenInfo(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const CORNER = new UDim(0, 6);

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
let settingsSummaryLabel: TextLabel | undefined;
let settingsControls: {
	parallelValue?: TextLabel;
	lightToggle?: TextButton;
	mappingToggle?: TextButton;
	autoPortToggle?: TextButton;
	verboseToggle?: TextButton;
} = {};

let refreshTabBar: () => void = () => {};
let switchToTab: (index: number) => void = () => {};

function tweenProp(instance: Instance, props: Record<string, unknown>) {
	TweenService.Create(instance, TWEEN_QUICK, props as unknown as { [key: string]: unknown }).Play();
}

function getStatusDotColor(connIndex: number): Color3 {
	const conn = State.getConnection(connIndex);
	if (!conn || !conn.isActive) return C.red;
	if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) return C.red;
	if (conn.lastHttpOk) return C.green;
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
	return {
		parallelAgents: math.clamp(tonumber(raw.parallelAgents) ?? defaults.parallelAgents, 1, 4),
		useLightModel: raw.useLightModel === true,
		useStructureMapping: raw.useStructureMapping !== false,
		autoPortDiscovery: raw.autoPortDiscovery !== false,
		verboseActivity: raw.verboseActivity !== false,
	};
}

function applySettingsUI(settings: PluginSettings) {
	if (settingsControls.parallelValue) {
		settingsControls.parallelValue.Text = tostring(settings.parallelAgents);
	}
	if (settingsControls.lightToggle) {
		settingsControls.lightToggle.Text = settings.useLightModel ? "ON" : "OFF";
		settingsControls.lightToggle.TextColor3 = settings.useLightModel ? C.green : C.muted;
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
	if (settingsSummaryLabel) {
		settingsSummaryLabel.Text = `Agents ${settings.parallelAgents} | Model ${settings.useLightModel ? "Light" : "Standard"} | Mapping ${settings.useStructureMapping ? "On" : "Off"}`;
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
	const hh = string.format("%02d", date.Hour);
	const mm = string.format("%02d", date.Minute);
	const ss = string.format("%02d", date.Second);
	return `${hh}:${mm}:${ss}`;
}

function levelColor(level: ActivityLevel): Color3 {
	if (level === "success") return C.green;
	if (level === "warn") return C.yellow;
	if (level === "error") return C.red;
	return C.blue;
}

function rebuildActivityRows() {
	const panel = viewPanels.get("activity");
	if (!panel) return;

	const list = panel.FindFirstChild("ActivityList") as Frame | undefined;
	if (!list) return;

	activityRows.forEach((row) => row.Destroy());
	activityRows.clear();

	const items = State.getActivity();
	if (items.size() === 0) {
		const emptyLabel = new Instance("TextLabel");
		emptyLabel.Name = "EmptyLabel";
		emptyLabel.Size = new UDim2(1, 0, 0, 22);
		emptyLabel.BackgroundTransparency = 1;
		emptyLabel.Text = "No activity yet.";
		emptyLabel.TextColor3 = C.muted;
		emptyLabel.TextSize = 10;
		emptyLabel.Font = Enum.Font.GothamMedium;
		emptyLabel.TextXAlignment = Enum.TextXAlignment.Left;
		emptyLabel.Parent = list;
		activityRows.set(-1, emptyLabel as unknown as Frame);
		return;
	}

	for (const item of items) {
		const row = new Instance("Frame");
		row.Size = new UDim2(1, 0, 0, 44);
		row.BackgroundColor3 = C.surfaceAlt;
		row.BorderSizePixel = 0;
		row.LayoutOrder = -item.id;
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
		title.Size = new UDim2(1, -70, 0, 16);
		title.Position = new UDim2(0, 20, 0, 2);
		title.BackgroundTransparency = 1;
		title.Text = item.title;
		title.TextColor3 = C.label;
		title.TextSize = 10;
		title.Font = Enum.Font.GothamSemibold;
		title.TextXAlignment = Enum.TextXAlignment.Left;
		title.TextTruncate = Enum.TextTruncate.AtEnd;
		title.Parent = row;

		const detail = new Instance("TextLabel");
		detail.Size = new UDim2(1, -70, 0, 16);
		detail.Position = new UDim2(0, 20, 0, 18);
		detail.BackgroundTransparency = 1;
		detail.Text = item.detail;
		detail.TextColor3 = C.muted;
		detail.TextSize = 9;
		detail.Font = Enum.Font.GothamMedium;
		detail.TextXAlignment = Enum.TextXAlignment.Left;
		detail.TextTruncate = Enum.TextTruncate.AtEnd;
		detail.Parent = row;

		const stamp = new Instance("TextLabel");
		stamp.Size = new UDim2(0, 46, 0, 14);
		stamp.Position = new UDim2(1, -50, 0, 2);
		stamp.BackgroundTransparency = 1;
		stamp.Text = formatTime(item.timestamp);
		stamp.TextColor3 = C.muted;
		stamp.TextSize = 8;
		stamp.Font = Enum.Font.GothamMedium;
		stamp.TextXAlignment = Enum.TextXAlignment.Right;
		stamp.Parent = row;

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
	for (let i = 0; i < State.getConnections().size(); i++) {
		createTabButton(i);
	}
};

switchToTab = (index: number) => {
	if (index < 0 || index >= State.getConnections().size()) return;
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

function pushActivity(level: ActivityLevel, title: string, detail: string, endpoint?: string) {
	const settings = State.getPluginSettings();
	if (!settings.verboseActivity && level === "info") {
		return;
	}
	State.addActivity(level, title, detail, endpoint);
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

	const overviewBtn = createTextButton(viewsBar, "Overview", new UDim2(0.34, -4, 1, 0), 1);
	const activityBtn = createTextButton(viewsBar, "Activity", new UDim2(0.33, -4, 1, 0), 2);
	const settingsBtn = createTextButton(viewsBar, "Settings", new UDim2(0.33, -4, 1, 0), 3);
	viewButtons.set("overview", overviewBtn);
	viewButtons.set("activity", activityBtn);
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

	const activityPanel = new Instance("Frame");
	activityPanel.Size = new UDim2(1, 0, 0, 250);
	activityPanel.BackgroundTransparency = 1;
	activityPanel.LayoutOrder = 8;
	activityPanel.Visible = false;
	activityPanel.Parent = card;

	createRowLabel(activityPanel, "MCP activity feed");

	const activityList = new Instance("Frame");
	activityList.Name = "ActivityList";
	activityList.Size = new UDim2(1, 0, 1, -18);
	activityList.Position = new UDim2(0, 0, 0, 18);
	activityList.BackgroundTransparency = 1;
	activityList.Parent = activityPanel;

	const activityLayout = new Instance("UIListLayout");
	activityLayout.Padding = new UDim(0, 4);
	activityLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	activityLayout.Parent = activityList;

	const settingsPanel = new Instance("Frame");
	settingsPanel.Size = new UDim2(1, 0, 0, 190);
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
	const [, mappingToggle] = createToggleRow(settingsPanel, "Use structure mapping");
	const [, autoPortToggle] = createToggleRow(settingsPanel, "Auto discover port");
	const [, verboseToggle] = createToggleRow(settingsPanel, "Verbose activity");

	settingsControls = {
		parallelValue,
		lightToggle,
		mappingToggle,
		autoPortToggle,
		verboseToggle,
	};

	viewPanels.set("overview", overviewPanel);
	viewPanels.set("activity", activityPanel);
	viewPanels.set("settings", settingsPanel);

	overviewBtn.Activated.Connect(() => setActiveView("overview"));
	activityBtn.Activated.Connect(() => setActiveView("activity"));
	settingsBtn.Activated.Connect(() => setActiveView("settings"));

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

	minusBtn.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ parallelAgents: math.max(1, current.parallelAgents - 1) });
	});
	plusBtn.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ parallelAgents: math.min(4, current.parallelAgents + 1) });
	});
	lightToggle.Activated.Connect(() => {
		const current = State.getPluginSettings();
		commitSettings({ useLightModel: !current.useLightModel });
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
	setActiveView("overview");
	pushActivity("info", "Plugin ready", "UI initialized and settings loaded");
}

function updateUIState() {
	const conn = State.getActiveConnection();
	if (!conn) return;
	const el = elements;

	if (conn.isActive) {
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
	} else {
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
	getElements: () => elements,
};
