import { v4 as uuidv4 } from 'uuid';

export type AgentTier = 'orchestrator' | 'senior' | 'junior' | 'observer';
export type SubscriptionStatus = 'active' | 'paused' | 'stopped' | 'expired';
export type TeamTokenMode = 'standard' | 'light';

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

export interface SubscriptionConfig {
  tier: AgentTier;
  quotaLimits: QuotaLimits;
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

export type SubscriptionEventType =
  | 'subscription_activated'
  | 'subscription_paused'
  | 'subscription_expired'
  | 'quota_exceeded'
  | 'overflow_rerouted';

export interface SubscriptionEvent {
  type: SubscriptionEventType;
  agentId: string;
  tier: AgentTier;
  quota?: { used: QuotaUsage; limit: QuotaLimits };
  timestamp: number;
  payload?: Record<string, unknown>;
}

export type SubscriptionCallback = (event: SubscriptionEvent) => void;

const TIER_DEFAULTS: Record<AgentTier, SubscriptionConfig> = {
  orchestrator: {
    tier: 'orchestrator',
    quotaLimits: { maxTokensIn: 200_000, maxTokensOut: 100_000, maxRequests: 500, windowMs: 3_600_000 },
  },
  senior: {
    tier: 'senior',
    quotaLimits: { maxTokensIn: 100_000, maxTokensOut: 50_000, maxRequests: 300, windowMs: 3_600_000 },
  },
  junior: {
    tier: 'junior',
    quotaLimits: { maxTokensIn: 40_000, maxTokensOut: 20_000, maxRequests: 100, windowMs: 3_600_000 },
  },
  observer: {
    tier: 'observer',
    quotaLimits: { maxTokensIn: 10_000, maxTokensOut: 5_000, maxRequests: 50, windowMs: 3_600_000 },
  },
};

const TIER_TEAM_MAP: Record<AgentTier, { teamId: string; lane: string; weight: number }> = {
  orchestrator: { teamId: 'orchestrator', lane: 'core', weight: 8 },
  senior: { teamId: 'senior', lane: 'core', weight: 4 },
  junior: { teamId: 'junior', lane: 'core', weight: 2 },
  observer: { teamId: 'observer', lane: 'background', weight: 1 },
};

export class SubscriptionManager {
  private subscriptions: Map<string, Subscription> = new Map();
  private callbacks: Map<string, SubscriptionCallback[]> = new Map();
  private windowCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.windowCleanupInterval = setInterval(() => this.cleanupWindows(), 60_000);
  }

  activate(agentId: string, tier?: AgentTier): Subscription {
    const inferredTier = tier ?? this.inferTier(agentId);
    const effectiveTier: AgentTier = inferredTier ?? 'junior';
    const config = TIER_DEFAULTS[effectiveTier] ?? TIER_DEFAULTS.junior;
    const team = TIER_TEAM_MAP[effectiveTier] ?? TIER_TEAM_MAP.junior;
    const now = Date.now();
    const sub: Subscription = {
      agentId,
      tier: effectiveTier,
      status: 'active',
      quotaLimits: { ...config.quotaLimits },
      quotaUsage: { tokensIn: 0, tokensOut: 0, requests: 0, windowStart: now },
      renewedAt: now,
      expiresAt: now + config.quotaLimits.windowMs,
      teamId: team.teamId,
      lane: team.lane,
    };
    this.subscriptions.set(agentId, sub);
    this.emit({ type: 'subscription_activated', agentId, tier: effectiveTier, timestamp: now });
    return sub;
  }

  get(agentId: string): Subscription | undefined {
    return this.subscriptions.get(agentId);
  }

  getAll(): Subscription[] {
    return [...this.subscriptions.values()];
  }

  getByTier(tier: AgentTier): Subscription[] {
    return [...this.subscriptions.values()].filter(s => s.tier === tier);
  }

  pause(agentId: string): boolean {
    const sub = this.subscriptions.get(agentId);
    if (!sub || sub.status !== 'active') return false;
    sub.status = 'paused';
    sub.renewedAt = Date.now();
    this.emit({ type: 'subscription_paused', agentId, tier: sub.tier, timestamp: sub.renewedAt });
    return true;
  }

  resume(agentId: string): boolean {
    const sub = this.subscriptions.get(agentId);
    if (!sub || sub.status !== 'paused') return false;
    sub.status = 'active';
    sub.renewedAt = Date.now();
    this.emit({ type: 'subscription_activated', agentId, tier: sub.tier, timestamp: sub.renewedAt });
    return true;
  }

  stop(agentId: string): boolean {
    const sub = this.subscriptions.get(agentId);
    if (!sub) return false;
    sub.status = 'stopped';
    sub.renewedAt = Date.now();
    this.emit({ type: 'subscription_expired', agentId, tier: sub.tier, timestamp: sub.renewedAt });
    return true;
  }

  recordUsage(agentId: string, tokensIn: number, tokensOut: number): QuotaUsage | null {
    const sub = this.subscriptions.get(agentId);
    if (!sub) return null;
    this.checkWindowReset(sub);
    sub.quotaUsage.tokensIn += tokensIn;
    sub.quotaUsage.tokensOut += tokensOut;
    sub.quotaUsage.requests += 1;
    const exceeded = this.checkQuota(sub);
    if (exceeded) {
      sub.status = 'expired';
      this.emit({
        type: 'quota_exceeded',
        agentId,
        tier: sub.tier,
        quota: { used: { ...sub.quotaUsage }, limit: { ...sub.quotaLimits } },
        timestamp: Date.now(),
      });
    }
    return { ...sub.quotaUsage };
  }

  checkQuota(sub: Subscription): boolean {
    const { tokensIn, tokensOut, requests } = sub.quotaUsage;
    const { maxTokensIn, maxTokensOut, maxRequests } = sub.quotaLimits;
    return tokensIn >= maxTokensIn || tokensOut >= maxTokensOut || requests >= maxRequests;
  }

  quotaRemaining(agentId: string): { tokensIn: number; tokensOut: number; requests: number } | null {
    const sub = this.subscriptions.get(agentId);
    if (!sub) return null;
    const { tokensIn, tokensOut, requests } = sub.quotaUsage;
    const { maxTokensIn, maxTokensOut, maxRequests } = sub.quotaLimits;
    return {
      tokensIn: Math.max(0, maxTokensIn - tokensIn),
      tokensOut: Math.max(0, maxTokensOut - tokensOut),
      requests: Math.max(0, maxRequests - requests),
    };
  }

  onOverflow(agentId: string, fallbackTier: AgentTier): boolean {
    const sub = this.subscriptions.get(agentId);
    if (!sub) return false;
    this.emit({
      type: 'overflow_rerouted',
      agentId,
      tier: sub.tier,
      payload: { fallbackTier },
      timestamp: Date.now(),
    });
    return true;
  }

  getTeamAndLane(agentId: string): { teamId: string; lane: string; weight: number } | null {
    const sub = this.subscriptions.get(agentId);
    if (!sub) return null;
    return TIER_TEAM_MAP[sub.tier];
  }

  onEvent(agentId: string, callback: SubscriptionCallback): () => void {
    const existing = this.callbacks.get(agentId) || [];
    existing.push(callback);
    this.callbacks.set(agentId, existing);
    return () => {
      const cbs = this.callbacks.get(agentId) || [];
      this.callbacks.set(agentId, cbs.filter(cb => cb !== callback));
    };
  }

  private emit(event: SubscriptionEvent) {
    const cbs = this.callbacks.get(event.agentId) || [];
    for (const cb of cbs) {
      try { cb(event); } catch { /* ignore */ }
    }
    const global = this.callbacks.get('*') || [];
    for (const cb of global) {
      try { cb(event); } catch { /* ignore */ }
    }
  }

  private checkWindowReset(sub: Subscription) {
    const now = Date.now();
    if (now - sub.quotaUsage.windowStart >= sub.quotaLimits.windowMs) {
      sub.quotaUsage.tokensIn = 0;
      sub.quotaUsage.tokensOut = 0;
      sub.quotaUsage.requests = 0;
      sub.quotaUsage.windowStart = now;
      sub.renewedAt = now;
      sub.expiresAt = now + sub.quotaLimits.windowMs;
    }
  }

  private cleanupWindows() {
    const now = Date.now();
    for (const sub of this.subscriptions.values()) {
      if (now - sub.quotaUsage.windowStart >= sub.quotaLimits.windowMs) {
        this.checkWindowReset(sub);
      }
      if (sub.status === 'expired' && now - sub.renewedAt > sub.quotaLimits.windowMs * 2) {
        this.subscriptions.delete(sub.agentId);
      }
    }
  }

  close() {
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
}
