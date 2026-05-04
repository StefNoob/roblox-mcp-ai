import State from "../modules/State";
import UI from "../modules/UI";
import Communication from "../modules/Communication";
import StructureMap from "../modules/StructureMap";
import ContextEngine from "../modules/ContextEngine";
import SwarmOrchestrator from "../modules/SwarmOrchestrator";
import ChatHub from "../modules/ChatHub";
import { getActivationOptions } from "../modules/ActivationMode";
import { buildRoiUiCommands } from "../modules/RoiCommandCatalog";

UI.init(plugin);
StructureMap.init();
ContextEngine.init();
SwarmOrchestrator.init();
ChatHub.init();
UI.refreshAgentMappingSection();
const elements = UI.getElements();

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

function syncConnectionTabs(target: number) {
	const desired = math.clamp(target, 1, State.MAX_CONNECTIONS);
	while (arrayCount(State.getConnections()) < desired) {
		State.addConnection();
	}
	while (arrayCount(State.getConnections()) > desired) {
		const lastIndex = arrayCount(State.getConnections()) - 1;
		const lastConn = State.getConnection(lastIndex);
		if (!lastConn || lastConn.isActive) break;
		if (!State.removeConnection(lastIndex)) break;
	}
}

syncConnectionTabs(State.getPluginSettings().parallelAgents);
UI.refreshConnectionTabs();
UI.updateUIState();

const startupConnection = State.getActiveConnection();
if (startupConnection && !startupConnection.isActive) {
	Communication.activatePlugin(State.getActiveTabIndex(), getActivationOptions("startup"));
}

UI.setQuickActions({
	onRefreshStructureMap: () => Communication.refreshStructureMapFromQuickAction(),
	onDiscoverPort: () => Communication.discoverAndApplyActivePort(),
	onSendReadyHandshake: () => Communication.sendReadyHandshakeForActive(),
	onClearActivity: () => Communication.clearActivityFeed(),
	onRetryFailedActivity: (retryContext) => Communication.retryFailedActivity(retryContext),
	onExecuteDirectCommand: (taskId, endpoint, params) => Communication.executeDirectCommand(taskId, endpoint, params),
});

for (const command of buildRoiUiCommands()) {
	UI.registerDirectCommand(command.name, command.description, command.endpoint, command.params);
}

UI.setSettingsChangedHandler((settings) => {
	syncConnectionTabs(settings.parallelAgents);
	UI.refreshConnectionTabs();
	UI.refreshAgentMappingSection();
	UI.refreshStructureExplorerSection();
	UI.pushActivity(
		"info",
		"Settings updated",
		`Agents ${settings.parallelAgents}, preset ${settings.teamPreset}, reviewer ${settings.reviewerLightMode ? "light" : "standard"}, qa ${settings.qaLightMode ? "light" : "standard"}`,
	);
});


const toolbar = plugin.CreateToolbar("MCP Integration");
const button = toolbar.CreateButton("MCP Server", "Connect to MCP Server for AI Integration", "rbxassetid://10734944444");


elements.connectButton.Activated.Connect(() => {
	const conn = State.getActiveConnection();
	if (conn && conn.isActive) {
		Communication.deactivatePlugin(State.getActiveTabIndex());
	} else {
		Communication.activatePlugin(State.getActiveTabIndex(), getActivationOptions("manual"));
	}
});


button.Click.Connect(() => {
	elements.screenGui.Enabled = !elements.screenGui.Enabled;
});


plugin.Unloading.Connect(() => {
	Communication.deactivateAll();
	StructureMap.shutdown();
	ContextEngine.shutdown();
	SwarmOrchestrator.shutdown();
	ChatHub.shutdown();
});


UI.updateUIState();
Communication.checkForUpdates();
