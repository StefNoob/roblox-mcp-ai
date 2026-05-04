import SwarmOrchestrator from "../SwarmOrchestrator";
import State from "../State";

function getSwarmStatus(_requestData: Record<string, unknown>) {
	const status = SwarmOrchestrator.getSwarmStatus();

	return {
		...status,
		timestamp: tick(),
	};
}

function getSwarmMetrics(_requestData: Record<string, unknown>) {
	const metrics = SwarmOrchestrator.getSwarmMetrics();

	return {
		...metrics,
		timestamp: tick(),
	};
}

function executeAgentCommand(requestData: Record<string, unknown>) {
	const agentId = requestData.agentId as string;
	const command = requestData.command as "pause" | "resume" | "stop" | "priority";
	const priority = requestData.priority as "high" | "medium" | "low" | undefined;
	const targetLane = requestData.targetLane as string | undefined;

	if (!agentId || !command) {
		return { success: false, error: "agentId and command are required" };
	}

	const result = SwarmOrchestrator.executeAgentCommand({
		agentId,
		command,
		priority,
		targetLane,
	});

	return {
		success: result,
		timestamp: tick(),
	};
}

function getLaneAssignments(_requestData: Record<string, unknown>) {
	const assignments = SwarmOrchestrator.getLaneAssignments();

	return {
		assignments,
		count: assignments.size(),
		timestamp: tick(),
	};
}

function getBestAvailableLane(_requestData: Record<string, unknown>) {
	const lane = SwarmOrchestrator.getBestAvailableLane();

	return {
		lane,
		found: lane !== undefined,
		timestamp: tick(),
	};
}

function recordLaneActivity(requestData: Record<string, unknown>) {
	const lane = requestData.lane as string;
	const action = requestData.action as "start" | "complete" | "fail" | "pending";
	const latencyMs = requestData.latencyMs as number | undefined;

	if (!lane || !action) {
		return { success: false, error: "lane and action are required" };
	}

	SwarmOrchestrator.recordLaneActivity(lane, action, latencyMs);

	return {
		success: true,
		timestamp: tick(),
	};
}

function syncWithTaskHistory(_requestData: Record<string, unknown>) {
	SwarmOrchestrator.syncWithTaskHistory();

	const status = SwarmOrchestrator.getSwarmStatus();

	return {
		success: true,
		...status,
		timestamp: tick(),
	};
}

export = {
	getSwarmStatus,
	getSwarmMetrics,
	executeAgentCommand,
	getLaneAssignments,
	getBestAvailableLane,
	recordLaneActivity,
	syncWithTaskHistory,
};