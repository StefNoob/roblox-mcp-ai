export type AgentLane = 'core' | 'reviewer' | 'qa' | 'background';

export type AgentStatus = 'active' | 'paused' | 'stopped' | 'error';

export interface LaneConfig {
  maxInFlight: number;
  weight: number;
  tokenMode: 'light' | 'standard';
  priority: number;
}

export interface AgentConfig {
  agentId: string;
  lane: AgentLane;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentState {
  agentId: string;
  threadId: string;
  lane: AgentLane;
  status: AgentStatus;
  messages: ChatMessage[];
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
  requestCount: number;
  createdAt: number;
  lastActivityAt: number;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  content: string;
  timestamp: number;
  tokensIn?: number;
  tokensOut?: number;
  toolCallId?: string;
  toolName?: string;
}

export interface AgentMetrics {
  tokensInTotal: number;
  tokensOutTotal: number;
  requestsTotal: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
  laneStats: LaneStats[];
}

export interface LaneStats {
  lane: AgentLane;
  inFlight: number;
  pending: number;
  completed: number;
}

export interface TeamProfile {
  maxConcurrency: number;
  defaultTeamId: string;
  laneWeights: Record<AgentLane, number>;
  teams: Record<AgentLane, LaneConfig>;
}

export interface OrchestratorConfig {
  maxConcurrency: number;
  defaultTeamId: string;
  laneWeights: Record<AgentLane, number>;
  teams: Record<AgentLane, LaneConfig>;
}

export interface SpawnOptions {
  agentId?: string;
  lane?: AgentLane;
  model?: string;
  systemPrompt?: string;
  threadId?: string;
  parentAgentId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatRequest {
  agentId: string;
  message: string;
  stream?: boolean;
}

export interface ChatResponse {
  success: boolean;
  response: string;
  agentId: string;
  threadId: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface AgentStatusResponse {
  agentId: string;
  threadId: string;
  status: AgentStatus;
  lane: AgentLane;
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
  requestCount: number;
  lastActivityAt: number;
  messageCount: number;
}

export interface AgentListResponse {
  agents: AgentStatusResponse[];
  total: number;
  metrics: AgentMetrics;
}

export interface ThreadInfo {
  threadId: string;
  agentId: string;
  lane: AgentLane;
  status: AgentStatus;
  messageCount: number;
  createdAt: number;
  lastActivityAt: number;
}