import State from "../modules/State";
import UI from "../modules/UI";
import Communication from "../modules/Communication";
import StructureMap from "../modules/StructureMap";

UI.init(plugin);
StructureMap.init();
const elements = UI.getElements();

function syncConnectionTabs(target: number) {
	const desired = math.clamp(target, 1, State.MAX_CONNECTIONS);
	while (State.getConnections().size() < desired) {
		State.addConnection();
	}
	while (State.getConnections().size() > desired) {
		const lastIndex = State.getConnections().size() - 1;
		const lastConn = State.getConnection(lastIndex);
		if (!lastConn || lastConn.isActive) break;
		if (!State.removeConnection(lastIndex)) break;
	}
}

syncConnectionTabs(State.getPluginSettings().parallelAgents);
UI.refreshConnectionTabs();
UI.updateUIState();

UI.setQuickActions({
	onRefreshStructureMap: () => Communication.refreshStructureMapFromQuickAction(),
	onDiscoverPort: () => Communication.discoverAndApplyActivePort(),
	onSendReadyHandshake: () => Communication.sendReadyHandshakeForActive(),
	onClearActivity: () => Communication.clearActivityFeed(),
});

UI.setSettingsChangedHandler((settings) => {
	syncConnectionTabs(settings.parallelAgents);
	UI.refreshConnectionTabs();
	UI.pushActivity(
		"info",
		"Settings updated",
		`Agents ${settings.parallelAgents}, model ${settings.useLightModel ? "light" : "standard"}, mapping ${settings.useStructureMapping ? "on" : "off"}`,
	);
});


const toolbar = plugin.CreateToolbar("MCP Integration");
const button = toolbar.CreateButton("MCP Server", "Connect to MCP Server for AI Integration", "rbxassetid://10734944444");


elements.connectButton.Activated.Connect(() => {
	const conn = State.getActiveConnection();
	if (conn && conn.isActive) {
		Communication.deactivatePlugin(State.getActiveTabIndex());
	} else {
		Communication.activatePlugin(State.getActiveTabIndex());
	}
});


button.Click.Connect(() => {
	elements.screenGui.Enabled = !elements.screenGui.Enabled;
});


plugin.Unloading.Connect(() => {
	Communication.deactivateAll();
	StructureMap.shutdown();
});


UI.updateUIState();
Communication.checkForUpdates();
