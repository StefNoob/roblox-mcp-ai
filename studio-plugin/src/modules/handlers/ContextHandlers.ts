import ContextEngine from "../ContextEngine";

function getRelevantFiles(requestData: Record<string, unknown>) {
	const agentId = (requestData.agentId as string) ?? "default";
	const limit = (requestData.limit as number) ?? 20;

	const files = ContextEngine.getRelevantFilesForAgent(agentId, limit);
	return {
		files,
		count: files.size(),
		timestamp: tick(),
	};
}

function loadContext(requestData: Record<string, unknown>) {
	const agentId = (requestData.agentId as string) ?? "default";
	const subsystems = requestData.subsystems as string[] | undefined;
	const priority = (requestData.priority as "high" | "medium" | "low") ?? "medium";
	const maxFiles = (requestData.maxFiles as number) ?? 15;

	const result = ContextEngine.loadContextForAgent({
		agentId,
		subsystems,
		priority,
		maxFiles,
	});

	return {
		...result,
		timestamp: tick(),
	};
}

function updateAgentFocus(requestData: Record<string, unknown>) {
	const agentId = (requestData.agentId as string) ?? "default";
	const subsystems = requestData.subsystems as string[];

	if (!subsystems) {
		return { success: false, error: "subsystems array is required" };
	}

	ContextEngine.updateAgentFocus(agentId, subsystems);

	return {
		success: true,
		agentId,
		activeSubsystems: subsystems,
		timestamp: tick(),
	};
}

function getAgentFocus(requestData: Record<string, unknown>) {
	const agentId = (requestData.agentId as string) ?? "default";

	const focus = ContextEngine.getAgentFocus(agentId);
	if (!focus) {
		return { found: false, agentId };
	}

	return {
		found: true,
		...focus,
		timestamp: tick(),
	};
}

function refreshContextCache(requestData: Record<string, unknown>) {
	const subsystem = requestData.subsystem as string | undefined;

	ContextEngine.refreshContextCache(subsystem);

	return {
		success: true,
		cacheSize: ContextEngine.getContextCacheSize(),
		timestamp: tick(),
	};
}

function invalidateStaleFiles(_requestData: Record<string, unknown>) {
	const invalidated = ContextEngine.invalidateStaleFiles();

	return {
		success: true,
		invalidated,
		timestamp: tick(),
	};
}

export = {
	getRelevantFiles,
	loadContext,
	updateAgentFocus,
	getAgentFocus,
	refreshContextCache,
	invalidateStaleFiles,
};