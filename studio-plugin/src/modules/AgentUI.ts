import State from "../modules/State";
import UI from "../modules/UI";

export type AgentLane = "core" | "reviewer" | "qa" | "background";
export type AgentStatusType = "active" | "paused" | "stopped" | "error";

export interface AgentInfo {
	agentId: string;
	threadId: string;
	lane: AgentLane;
	status: AgentStatusType;
	messageCount: number;
	tokensIn: number;
	tokensOut: number;
	avgLatencyMs: number;
	lastActivityAt: number;
}

export interface AgentMetricsInfo {
	tokensInTotal: number;
	tokensOutTotal: number;
	requestsTotal: number;
	avgLatencyMs: number;
	p50LatencyMs: number;
	p99LatencyMs: number;
	laneStats: Array<{
		lane: AgentLane;
		inFlight: number;
		pending: number;
		completed: number;
	}>;
}

export interface AgentListResponse {
	agents: AgentInfo[];
	total: number;
	metrics: AgentMetricsInfo;
}

const LANE_COLORS: Record<AgentLane, Color3> = {
	core: Color3.fromRGB(59, 130, 246),
	reviewer: Color3.fromRGB(168, 85, 247),
	qa: Color3.fromRGB(34, 197, 94),
	background: Color3.fromRGB(156, 163, 175),
};

const STATUS_COLORS: Record<AgentStatusType, Color3> = {
	active: Color3.fromRGB(34, 197, 94),
	paused: Color3.fromRGB(245, 158, 11),
	stopped: Color3.fromRGB(107, 114, 128),
	error: Color3.fromRGB(239, 68, 68),
};

function formatTimestamp(unixMs: number): string {
	return DateTime.fromUnixTimestamp(math.floor(unixMs / 1000)).FormatLocalTime("HH:mm:ss", "en-us");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${math.floor(ms / 1000)}s`;
	return `${math.floor(ms / 60000)}m`;
}

function renderAgentCard(agent: AgentInfo): Frame {
	const frame = UI.create("Frame")({
		Size: new UDim2(1, 0, 0, 64),
		BackgroundColor3: Color3.fromRGB(30, 30, 30),
		BorderSizePixel: 0,
	});

	const laneColor = LANE_COLORS[agent.lane] || Color3.fromRGB(156, 163, 175);
	const statusColor = STATUS_COLORS[agent.status] || Color3.fromRGB(156, 163, 175);

	const laneIndicator = UI.create("Frame")({
		Size: new UDim2(0, 4, 1, -16),
		Position: new UDim2(0, 8, 0, 8),
		BackgroundColor3: laneColor,
		Parent: frame,
	});

	const nameLabel = UI.create("TextLabel")({
		Size: new UDim2(0.5, -20, 0, 18),
		Position: new UDim2(0, 20, 0, 8),
		Text: agent.agentId,
		TextColor3: Color3.fromRGB(255, 255, 255),
		TextSize: 14,
		TextXAlignment: Enum.TextXAlignment.Left,
		Font: Enum.Font.GothamBold,
		Parent: frame,
	});

	const statusDot = UI.create("Frame")({
		Size: new UDim2(0, 8, 0, 8),
		Position: new UDim2(0, 20, 0, 30),
		BackgroundColor3: statusColor,
		Parent: frame,
	});

	const statusLabel = UI.create("TextLabel")({
		Size: new UDim2(0, 60, 0, 14),
		Position: new UDim2(0, 32, 0, 27),
		Text: agent.status,
		TextColor3: statusColor,
		TextSize: 11,
		TextXAlignment: Enum.TextXAlignment.Left,
		Font: Enum.Font.Gotham,
		Parent: frame,
	});

	const laneLabel = UI.create("TextLabel")({
		Size: new UDim2(0, 60, 0, 14),
		Position: new UDim2(0.4, 0, 0, 27),
		Text: agent.lane,
		TextColor3: laneColor,
		TextSize: 11,
		TextXAlignment: Enum.TextXAlignment.Left,
		Font: Enum.Font.Gotham,
		Parent: frame,
	});

	const lastActivityLabel = UI.create("TextLabel")({
		Size: new UDim2(0.3, -10, 0, 14),
		Position: new UDim2(0.6, 0, 0, 27),
		Text: formatTimestamp(agent.lastActivityAt),
		TextColor3: Color3.fromRGB(156, 163, 175),
		TextSize: 11,
		TextXAlignment: Enum.TextXAlignment.Right,
		Font: Enum.Font.Gotham,
		Parent: frame,
	});

	const msgCountLabel = UI.create("TextLabel")({
		Size: new UDim2(0, 40, 0, 14),
		Position: new UDim2(0, -8, 0, 44),
		AnchorPoint: new Vector2(1, 0),
		Text: `${agent.messageCount} msg`,
		TextColor3: Color3.fromRGB(156, 163, 175),
		TextSize: 10,
		TextXAlignment: Enum.TextXAlignment.Right,
		Font: Enum.Font.Gotham,
		Parent: frame,
	});

	return frame;
}

function renderMetricsCard(metrics: AgentMetricsInfo): Frame {
	const frame = UI.create("Frame")({
		Size: new UDim2(1, 0, 0, 100),
		BackgroundColor3: Color3.fromRGB(25, 25, 25),
		BorderSizePixel: 0,
	});

	const title = UI.create("TextLabel")({
		Size: new UDim2(1, -16, 0, 20),
		Position: new UDim2(0, 8, 0, 8),
		Text: "Agent Metrics",
		TextColor3: Color3.fromRGB(255, 255, 255),
		TextSize: 13,
		TextXAlignment: Enum.TextXAlignment.Left,
		Font: Enum.Font.GothamBold,
		Parent: frame,
	});

	const stats = `Tokens In: ${metrics.tokensInTotal} | Out: ${metrics.tokensOutTotal} | Reqs: ${metrics.requestsTotal}`;
	const statsLabel = UI.create("TextLabel")({
		Size: new UDim2(1, -16, 0, 16),
		Position: new UDim2(0, 8, 0, 32),
		Text: stats,
		TextColor3: Color3.fromRGB(200, 200, 200),
		TextSize: 11,
		TextXAlignment: Enum.TextXAlignment.Left,
		Font: Enum.Font.Gotham,
		Parent: frame,
	});

	const latency = `Latency: avg ${metrics.avgLatencyMs}ms | p50 ${metrics.p50LatencyMs}ms | p99 ${metrics.p99LatencyMs}ms`;
	const latencyLabel = UI.create("TextLabel")({
		Size: new UDim2(1, -16, 0, 16),
		Position: new UDim2(0, 8, 0, 52),
		Text: latency,
		TextColor3: Color3.fromRGB(156, 163, 175),
		TextSize: 11,
		TextXAlignment: Enum.TextXAlignment.Left,
		Font: Enum.Font.Gotham,
		Parent: frame,
	});

	const laneY = 72;
	for (let i = 0; i < metrics.laneStats.size(); i++) {
		const stat = metrics.laneStats[i];
		const laneColor = LANE_COLORS[stat.lane as AgentLane] || Color3.fromRGB(156, 163, 175);
		const xOffset = 8 + (i * 80);

		const laneLabel = UI.create("TextLabel")({
			Size: new UDim2(0, 70, 0, 14),
			Position: new UDim2(0, xOffset, 0, laneY),
			Text: `${stat.lane}: ${stat.inFlight}/${stat.pending}`,
			TextColor3: laneColor,
			TextSize: 10,
			TextXAlignment: Enum.TextXAlignment.Left,
			Font: Enum.Font.Gotham,
			Parent: frame,
		});
	}

	return frame;
}

export function refreshAgentPanel(): void {
	const elements = UI.getElements();
	const panel = elements.agentPanel;

	for (const child of panel.GetChildren()) {
		child.Destroy();
	}

	const listResponse = HttpService.RequestAsync({
		Url: `${State.getActiveConnection()?.serverUrl ?? ""}/api/agent-list`,
		Method: "GET",
		Headers: { "Content-Type": "application/json" },
	});

	let response: AgentListResponse = { agents: [], total: 0, metrics: { tokensInTotal: 0, tokensOutTotal: 0, requestsTotal: 0, avgLatencyMs: 0, p50LatencyMs: 0, p99LatencyMs: 0, laneStats: [] } };

	if (listResponse.Success) {
		const [ok, decoded] = pcall(() => HttpService.JSONDecode(listResponse.Body) as AgentListResponse);
		if (ok) {
			response = decoded;
		}
	}

	const metricsCard = renderMetricsCard(response.metrics);
	metricsCard.Parent = panel;

	let yOffset = 108;
	for (const agent of response.agents) {
		const card = renderAgentCard(agent);
		card.Position = new UDim2(0, 0, 0, yOffset);
		card.Parent = panel;
		yOffset += 68;
	}
}

export function initAgentPanel(): void {
	const elements = UI.getElements();

	const agentPanel = UI.create("ScrollingFrame")({
		Name: "AgentPanel",
		Size: new UDim2(1, -16, 1, -8),
		Position: new UDim2(0, 8, 0, 4),
		BackgroundColor3: Color3.fromRGB(20, 20, 20),
		BorderSizePixel: 0,
		ScrollBarThickness: 4,
		CanvasSize: new UDim2(0, 0, 0, 400),
		AutoButtonColor: false,
	});

	const layout = UI.create("UIListLayout")({
		SortOrder: Enum.SortOrder.LayoutOrder,
		Padding: UDim.new(0, 4),
		Parent: agentPanel,
	});

	elements.agentPanel = agentPanel;
}