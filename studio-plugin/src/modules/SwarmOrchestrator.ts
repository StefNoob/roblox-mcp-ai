import State from "./State";
import { AgentStatusInfo, AgentTeamType, LaneConfig } from "../types";
import TaskHistory from "./TaskHistory";

export interface LaneHealth {
	lane: string;
	inFlight: number;
	maxInFlight: number;
	weight: number;
	pending: number;
	completed: number;
	failed: number;
	avgLatencyMs: number;
	status: "healthy" | "busy" | "stalled" | "overloaded";
}

export interface SwarmStatus {
	totalAgents: number;
	activeAgents: number;
	pausedAgents: number;
	stoppedAgents: number;
	totalTokensIn: number;
	totalTokensOut: number;
	avgLatencyMs: number;
	laneHealth: LaneHealth[];
	overallStatus: "healthy" | "degraded" | "critical";
	lastUpdatedAt: number;
}

export interface AgentCommand {
	agentId: string;
	command: "pause" | "resume" | "stop" | "priority";
	priority?: "high" | "medium" | "low";
	targetLane?: string;
}

export interface SwarmMetrics {
	requestsTotal: number;
	tokensInTotal: number;
	tokensOutTotal: number;
	avgLatencyMs: number;
	p50LatencyMs: number;
	p99LatencyMs: number;
	laneStats: Array<{
		lane: string;
		activeAgents: number;
		inFlight: number;
		pending: number;
		completed: number;
	}>;
}

const LANE_NAMES = ["core", "reviewer", "qa", "background"];
let swarmInitialized = false;
let laneMetrics = new Map<string, {
	inFlight: number;
	pending: number;
	completed: number;
	failed: number;
	latencies: number[];
}>();

function initLaneMetrics(): void {
	for (const lane of LANE_NAMES) {
		laneMetrics.set(lane, {
			inFlight: 0,
			pending: 0,
			completed: 0,
			failed: 0,
			latencies: [],
		});
	}
}

function calculateLaneHealth(lane: string, config: LaneConfig): LaneHealth {
	const metrics = laneMetrics.get(lane) ?? {
		inFlight: 0,
		pending: 0,
		completed: 0,
		failed: 0,
		latencies: [],
	};

	let status: LaneHealth["status"] = "healthy";
	const utilization = metrics.inFlight / config.maxInFlight;

	if (utilization >= 1.0) {
		status = "overloaded";
	} else if (utilization >= 0.8) {
		status = "busy";
	} else if (metrics.pending > config.maxInFlight * 2) {
		status = "stalled";
	}

	const avgLatencyMs = metrics.latencies.size() > 0
		? metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.size()
		: 0;

	return {
		lane,
		inFlight: metrics.inFlight,
		maxInFlight: config.maxInFlight,
		weight: config.weight,
		pending: metrics.pending,
		completed: metrics.completed,
		failed: metrics.failed,
		avgLatencyMs: math.round(avgLatencyMs * 100) / 100,
		status,
	};
}

function getSwarmStatus(): SwarmStatus {
	const agentSettings = State.getAgentSettings();
	const allStatus = State.getAllAgentStatus();

	let activeCount = 0;
	let pausedCount = 0;
	let stoppedCount = 0;
	let totalTokensIn = 0;
	let totalTokensOut = 0;
	let totalLatency = 0;
	let latencyCount = 0;

	for (const status of allStatus) {
		switch (status.status) {
			case "active":
				activeCount += 1;
				break;
			case "paused":
				pausedCount += 1;
				break;
			case "stopped":
				stoppedCount += 1;
				break;
		}
		totalTokensIn += status.tokensIn;
		totalTokensOut += status.tokensOut;
		if (status.avgLatencyMs > 0) {
			totalLatency += status.avgLatencyMs;
			latencyCount += 1;
		}
	}

	const laneHealth: LaneHealth[] = [];
	for (const [lane, config] of pairs(agentSettings.laneConfig)) {
		const laneKey = lane as string;
		laneHealth.push(calculateLaneHealth(laneKey, config));
	}

	let overallStatus: SwarmStatus["overallStatus"] = "healthy";
	const criticalLanes = laneHealth.filter((h) => h.status === "overloaded" || h.status === "stalled");
	if (criticalLanes.size() > 0) {
		overallStatus = "critical";
	} else {
		const degradedLanes = laneHealth.filter((h) => h.status === "busy");
		if (degradedLanes.size() > LANE_NAMES.size() / 2) {
			overallStatus = "degraded";
		}
	}

	return {
		totalAgents: allStatus.size(),
		activeAgents: activeCount,
		pausedAgents: pausedCount,
		stoppedAgents: stoppedCount,
		totalTokensIn,
		totalTokensOut,
		avgLatencyMs: latencyCount > 0 ? math.round(totalLatency / latencyCount) : 0,
		laneHealth,
		overallStatus,
		lastUpdatedAt: tick(),
	};
}

function getSwarmMetrics(): SwarmMetrics {
	const agentSettings = State.getAgentSettings();
	const allStatus = State.getAllAgentStatus();

	let requestsTotal = 0;
	let tokensInTotal = 0;
	let tokensOutTotal = 0;
	let totalLatency = 0;
	let latencies: number[] = [];

	for (const status of allStatus) {
		requestsTotal += status.requestCount;
		tokensInTotal += status.tokensIn;
		tokensOutTotal += status.tokensOut;
		if (status.avgLatencyMs > 0) {
			latencies.push(status.avgLatencyMs);
		}
	}

	latencies.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const p50Idx = math.floor(latencies.size() * 0.5);
	const p99Idx = math.floor(latencies.size() * 0.99);

	const laneStats: SwarmMetrics["laneStats"] = [];
	for (const [lane, config] of pairs(agentSettings.laneConfig)) {
		const laneKey = lane as string;
		const metrics = laneMetrics.get(laneKey);
		laneStats.push({
			lane: laneKey,
			activeAgents: 0,
			inFlight: metrics?.inFlight ?? 0,
			pending: metrics?.pending ?? 0,
			completed: metrics?.completed ?? 0,
		});
	}

	return {
		requestsTotal,
		tokensInTotal,
		tokensOutTotal,
		avgLatencyMs: latencies.size() > 0 ? totalLatency / latencies.size() : 0,
		p50LatencyMs: latencies[p50Idx] ?? 0,
		p99LatencyMs: latencies[p99Idx] ?? 0,
		laneStats,
	};
}

function recordLaneActivity(
	lane: string,
	action: "start" | "complete" | "fail" | "pending",
	latencyMs?: number,
): void {
	const metrics = laneMetrics.get(lane);
	if (!metrics) return;

	switch (action) {
		case "start":
			metrics.inFlight += 1;
			break;
		case "complete":
			metrics.inFlight = math.max(0, metrics.inFlight - 1);
			metrics.completed += 1;
			if (latencyMs !== undefined) {
				metrics.latencies.push(latencyMs);
				if (metrics.latencies.size() > 100) {
					metrics.latencies.shift();
				}
			}
			break;
		case "fail":
			metrics.inFlight = math.max(0, metrics.inFlight - 1);
			metrics.failed += 1;
			break;
		case "pending":
			metrics.pending += 1;
			break;
	}
}

function executeAgentCommand(command: AgentCommand): boolean {
	const status = State.getAgentStatus(command.agentId);
	if (!status) return false;

	switch (command.command) {
		case "pause":
			State.updateAgentStatus(command.agentId, { ...status, status: "paused" });
			return true;
		case "resume":
			State.updateAgentStatus(command.agentId, { ...status, status: "active" });
			return true;
		case "stop":
			State.updateAgentStatus(command.agentId, { ...status, status: "stopped" });
			return true;
	}

	return false;
}

function getLaneAssignments(): Array<{ lane: string; weight: number; maxInFlight: number; activeAgents: number }> {
	const agentSettings = State.getAgentSettings();
	const assignments: Array<{ lane: string; weight: number; maxInFlight: number; activeAgents: number }> = [];

	for (const [lane, config] of pairs(agentSettings.laneConfig)) {
		const laneKey = lane as string;
		assignments.push({
			lane: laneKey,
			weight: config.weight,
			maxInFlight: config.maxInFlight,
			activeAgents: 0,
		});
	}

	return assignments;
}

function getBestAvailableLane(): string | undefined {
	const agentSettings = State.getAgentSettings();
	let bestLane: string | undefined;
	let bestScore = -1;

	for (const [lane, config] of pairs(agentSettings.laneConfig)) {
		const laneKey = lane as string;
		const metrics = laneMetrics.get(laneKey);
		if (!metrics) continue;

		if (metrics.inFlight >= config.maxInFlight) continue;

		const score = config.weight / (metrics.inFlight + 1);
		if (score > bestScore) {
			bestScore = score;
			bestLane = laneKey;
		}
	}

	return bestLane;
}

function syncWithTaskHistory(): void {
	for (const lane of LANE_NAMES) {
		const metrics = laneMetrics.get(lane);
		if (!metrics) continue;

		const tasks = TaskHistory.getTasks({ status: "in_progress" });
		let laneTaskCount = 0;

		for (const task of tasks) {
			if (task.agentId) {
				laneTaskCount += 1;
			}
		}

		metrics.inFlight = laneTaskCount;
	}
}

function init(): void {
	if (swarmInitialized) return;
	swarmInitialized = true;
	initLaneMetrics();
}

function shutdown(): void {
	laneMetrics.clear();
	swarmInitialized = false;
}

export = {
	init,
	shutdown,
	getSwarmStatus,
	getSwarmMetrics,
	recordLaneActivity,
	executeAgentCommand,
	getLaneAssignments,
	getBestAvailableLane,
	syncWithTaskHistory,
};