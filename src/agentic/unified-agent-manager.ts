import { v4 as uuidv4 } from 'uuid';
import type { AgentLane, AgentStatus as AgentStatusType, ChatMessage, SpawnOptions } from '../agents/types.js';

export type AgentTier = 'orchestrator' | 'senior' | 'junior' | 'observer';
export type SubscriptionStatus = 'active' | 'paused' | 'stopped' | 'expired';

export interface QuotaLimits {
  maxTokensIn: number;
  maxTokensOut: number;
  maxRequests: number;
  windowMs: number;
}

export interface QuotaUsage {
  tokensIn: number;
  tokensOut: number;
  requests: number;
  windowStart: number;
}

export interface Subscription {
  agentId: string;
  tier: AgentTier;
  status: SubscriptionStatus;
  quotaLimits: QuotaLimits;
  quotaUsage: QuotaUsage;
  renewedAt: number;
  expiresAt: number;
  teamId: string;
  lane: string;
}

export interface UnifiedAgent {
  agentId: string;
  threadId: string;
  tier: AgentTier;
  lane: AgentLane;
  status: AgentStatusType;
  subscription: Subscription;
  messages: ChatMessage[];
  tokensIn: number;
  tokensOut: number;
  avgLatencyMs: number;
  requestCount: number;
  createdAt: number;
  lastActivityAt: number;
  error?: string;
}

export interface UnifiedAgentMetrics {
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

const DEFAULT_LANES: AgentLane[] = ['core', 'reviewer', 'qa', 'background'];

const TIER_DEFAULTS: Record<AgentTier, { quotaLimits: QuotaLimits }> = {
  orchestrator: { quotaLimits: { maxTokensIn: 200_000, maxTokensOut: 100_000, maxRequests: 500, windowMs: 3_600_000 } },
  senior: { quotaLimits: { maxTokensIn: 100_000, maxTokensOut: 50_000, maxRequests: 300, windowMs: 3_600_000 } },
  junior: { quotaLimits: { maxTokensIn: 40_000, maxTokensOut: 20_000, maxRequests: 100, windowMs: 3_600_000 } },
  observer: { quotaLimits: { maxTokensIn: 10_000, maxTokensOut: 5_000, maxRequests: 50, windowMs: 3_600_000 } },
};

const TIER_TEAM_MAP: Record<AgentTier, { teamId: string; lane: string; weight: number }> = {
  orchestrator: { teamId: 'orchestrator', lane: 'core', weight: 8 },
  senior: { teamId: 'senior', lane: 'core', weight: 4 },
  junior: { teamId: 'junior', lane: 'core', weight: 2 },
  observer: { teamId: 'observer', lane: 'background', weight: 1 },
};

export class UnifiedAgentManager {
  private static instance: UnifiedAgentManager;
  private agents: Map<string, UnifiedAgent> = new Map();
  private threads: Map<string, string> = new Map();
  private latencySamples: Map<string, number[]> = new Map();
  private maxLatencySamples = 200;
  private windowCleanupInterval: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    this.windowCleanupInterval = setInterval(() => this.cleanupWindows(), 60_000);
  }

  static getInstance(): UnifiedAgentManager {
    if (!UnifiedAgentManager.instance) {
      UnifiedAgentManager.instance = new UnifiedAgentManager();
    }
    return UnifiedAgentManager.instance;
  }

  spawn(opts: SpawnOptions = {}): UnifiedAgent {
    const agentId = opts.agentId || `agent_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const threadId = opts.threadId || `th_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const tier = this.inferTier(agentId);
    const team = TIER_TEAM_MAP[tier];
    const now = Date.now();

    const subscription: Subscription = {
      agentId,
      tier,
      status: 'active',
      quotaLimits: { ...TIER_DEFAULTS[tier].quotaLimits },
      quotaUsage: { tokensIn: 0, tokensOut: 0, requests: 0, windowStart: now },
      renewedAt: now,
      expiresAt: now + TIER_DEFAULTS[tier].quotaLimits.windowMs,
      teamId: team.teamId,
      lane: team.lane,
    };

    const agent: UnifiedAgent = {
      agentId,
      threadId,
      tier,
      lane: (opts.lane as AgentLane) || team.lane as AgentLane,
      status: 'active',
      subscription,
      messages: [],
      tokensIn: 0,
      tokensOut: 0,
      avgLatencyMs: 0,
      requestCount: 0,
      createdAt: now,
      lastActivityAt: now,
    };

    if (opts.systemPrompt) {
      agent.messages.push({
        id: uuidv4(),
        role: 'system',
        content: opts.systemPrompt,
        timestamp: now,
      });
    }

    this.agents.set(agentId, agent);
    this.threads.set(threadId, agentId);
    this.latencySamples.set(agentId, []);

    return agent;
  }

  get(agentId: string): UnifiedAgent | undefined {
    return this.agents.get(agentId);
  }

  getByThread(threadId: string): UnifiedAgent | undefined {
    const agentId = this.threads.get(threadId);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  getAll(): UnifiedAgent[] {
    return [...this.agents.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  getByLane(lane: AgentLane): UnifiedAgent[] {
    return this.getAll().filter(a => a.lane === lane);
  }

  getByTier(tier: AgentTier): UnifiedAgent[] {
    return this.getAll().filter(a => a.tier === tier);
  }

  update(agentId: string, patch: Partial<UnifiedAgent>): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    const updated = { ...agent, ...patch, lastActivityAt: Date.now() };
    this.agents.set(agentId, updated);
    return true;
  }

  pause(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'active') return false;
    agent.status = 'paused';
    agent.subscription.status = 'paused';
    agent.lastActivityAt = Date.now();
    return true;
  }

  resume(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'paused') return false;
    agent.status = 'active';
    agent.subscription.status = 'active';
    agent.lastActivityAt = Date.now();
    return true;
  }

  stop(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.status = 'stopped';
    agent.subscription.status = 'stopped';
    agent.lastActivityAt = Date.now();
    return true;
  }

  setError(agentId: string, error: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.status = 'error';
    agent.error = error;
    agent.lastActivityAt = Date.now();
    return true;
  }

  addMessage(agentId: string, message: ChatMessage): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.messages.push(message);
    agent.lastActivityAt = Date.now();
    if (message.role === 'user' || message.role === 'tool') {
      agent.tokensIn += message.tokensIn || Math.ceil(message.content.length / 4);
    } else if (message.role === 'assistant') {
      agent.tokensOut += message.tokensOut || Math.ceil(message.content.length / 4);
    }
    agent.requestCount += 1;
    return true;
  }

  recordLatency(agentId: string, latencyMs: number): void {
    const samples = this.latencySamples.get(agentId) || [];
    samples.push(latencyMs);
    if (samples.length > this.maxLatencySamples) {
      samples.shift();
    }
    this.latencySamples.set(agentId, samples);
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.avgLatencyMs = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    }
  }

  getTier(agentId: string): AgentTier | undefined {
    const agent = this.agents.get(agentId);
    return agent?.tier;
  }

  checkQuota(agentId: string): { exceeded: boolean; remaining: QuotaUsage | null } {
    const agent = this.agents.get(agentId);
    if (!agent) return { exceeded: false, remaining: null };
    const sub = agent.subscription;
    const { tokensIn, tokensOut, requests } = sub.quotaUsage;
    const { maxTokensIn, maxTokensOut, maxRequests } = sub.quotaLimits;
    return {
      exceeded: tokensIn >= maxTokensIn || tokensOut >= maxTokensOut || requests >= maxRequests,
      remaining: {
        tokensIn: Math.max(0, maxTokensIn - tokensIn),
        tokensOut: Math.max(0, maxTokensOut - tokensOut),
        requests: Math.max(0, maxRequests - requests),
        windowStart: sub.quotaUsage.windowStart,
      },
    };
  }

  recordUsage(agentId: string, tokensIn: number, tokensOut: number): QuotaUsage | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    this.checkWindowReset(agent.subscription);
    agent.subscription.quotaUsage.tokensIn += tokensIn;
    agent.subscription.quotaUsage.tokensOut += tokensOut;
    agent.subscription.quotaUsage.requests += 1;
    return { ...agent.subscription.quotaUsage };
  }

  quotaRemaining(agentId: string): { tokensIn: number; tokensOut: number; requests: number } | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const { tokensIn, tokensOut, requests } = agent.subscription.quotaUsage;
    const { maxTokensIn, maxTokensOut, maxRequests } = agent.subscription.quotaLimits;
    return {
      tokensIn: Math.max(0, maxTokensIn - tokensIn),
      tokensOut: Math.max(0, maxTokensOut - tokensOut),
      requests: Math.max(0, maxRequests - requests),
    };
  }

  getTeamAndLane(agentId: string): { teamId: string; lane: string; weight: number } | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return TIER_TEAM_MAP[agent.tier];
  }

  getMetrics(): UnifiedAgentMetrics {
    let tokensInTotal = 0;
    let tokensOutTotal = 0;
    const allLatencySamples: number[] = [];
    for (const samples of this.latencySamples.values()) {
      allLatencySamples.push(...samples);
    }
    for (const agent of this.agents.values()) {
      tokensInTotal += agent.tokensIn;
      tokensOutTotal += agent.tokensOut;
    }
    allLatencySamples.sort((a, b) => a - b);
    const p50 = allLatencySamples.length > 0 ? allLatencySamples[Math.floor(allLatencySamples.length * 0.5)] : 0;
    const p99 = allLatencySamples.length > 0 ? allLatencySamples[Math.floor(allLatencySamples.length * 0.99)] || allLatencySamples[allLatencySamples.length - 1] : 0;
    return {
      tokensInTotal,
      tokensOutTotal,
      requestsTotal: [...this.agents.values()].reduce((sum, a) => sum + a.requestCount, 0),
      avgLatencyMs: allLatencySamples.length > 0 ? Math.round(allLatencySamples.reduce((a, b) => a + b, 0) / allLatencySamples.length) : 0,
      p50LatencyMs: p50,
      p99LatencyMs: p99,
      laneStats: DEFAULT_LANES.map(lane => ({
        lane,
        inFlight: this.getByLane(lane).filter(a => a.status === 'active').length,
        pending: this.getByLane(lane).filter(a => a.status === 'paused').length,
        completed: this.getByLane(lane).filter(a => a.status === 'stopped').length,
      })),
    };
  }

  countByStatus(status: AgentStatusType): number {
    return [...this.agents.values()].filter(a => a.status === status).length;
  }

  countByLane(lane: AgentLane): number {
    return this.getByLane(lane).length;
  }

  remove(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this.threads.delete(agent.threadId);
    this.latencySamples.delete(agentId);
    this.agents.delete(agentId);
    return true;
  }

  clear(): void {
    this.agents.clear();
    this.threads.clear();
    this.latencySamples.clear();
  }

  close(): void {
    if (this.windowCleanupInterval) {
      clearInterval(this.windowCleanupInterval);
    }
  }

  private inferTier(agentId: string): AgentTier {
    if (agentId.includes('orchestrator')) return 'orchestrator';
    if (agentId.includes('senior')) return 'senior';
    if (agentId.includes('junior')) return 'junior';
    if (agentId.includes('observer')) return 'observer';
    return 'junior';
  }

  private checkWindowReset(subscription: Subscription): void {
    const now = Date.now();
    if (now - subscription.quotaUsage.windowStart >= subscription.quotaLimits.windowMs) {
      subscription.quotaUsage.tokensIn = 0;
      subscription.quotaUsage.tokensOut = 0;
      subscription.quotaUsage.requests = 0;
      subscription.quotaUsage.windowStart = now;
      subscription.renewedAt = now;
      subscription.expiresAt = now + subscription.quotaLimits.windowMs;
    }
  }

  private cleanupWindows(): void {
    const now = Date.now();
    for (const agent of this.agents.values()) {
      const sub = agent.subscription;
      if (now - sub.quotaUsage.windowStart >= sub.quotaLimits.windowMs) {
        this.checkWindowReset(sub);
      }
      if (sub.status === 'expired' && now - sub.renewedAt > sub.quotaLimits.windowMs * 2) {
        this.agents.delete(agent.agentId);
      }
    }
  }
}

export const unifiedAgentManager = UnifiedAgentManager.getInstance();
