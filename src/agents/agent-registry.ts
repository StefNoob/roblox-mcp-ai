import { v4 as uuidv4 } from 'uuid';
import {
  type AgentState,
  type AgentLane,
  type AgentStatus,
  type ChatMessage,
  type SpawnOptions,
} from './types.js';

const DEFAULT_LANES: AgentLane[] = ['core', 'reviewer', 'qa', 'background'];

export class AgentRegistry {
  private agents: Map<string, AgentState> = new Map();
  private threads: Map<string, string> = new Map();
  private latencySamples: Map<string, number[]> = new Map();
  private maxLatencySamples = 200;

  spawn(opts: SpawnOptions = {}): AgentState {
    const agentId = opts.agentId || `agent_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const threadId = opts.threadId || `th_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

    const state: AgentState = {
      agentId,
      threadId,
      lane: opts.lane || 'core',
      status: 'active',
      messages: [],
      tokensIn: 0,
      tokensOut: 0,
      avgLatencyMs: 0,
      requestCount: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    if (opts.systemPrompt) {
      state.messages.push({
        id: uuidv4(),
        role: 'system',
        content: opts.systemPrompt,
        timestamp: Date.now(),
      });
    }

    this.agents.set(agentId, state);
    this.threads.set(threadId, agentId);

    if (!this.latencySamples.has(agentId)) {
      this.latencySamples.set(agentId, []);
    }

    return state;
  }

  get(agentId: string): AgentState | undefined {
    return this.agents.get(agentId);
  }

  getByThread(threadId: string): AgentState | undefined {
    const agentId = this.threads.get(threadId);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  getAll(): AgentState[] {
    return [...this.agents.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  getByLane(lane: AgentLane): AgentState[] {
    return this.getAll().filter(a => a.lane === lane);
  }

  update(agentId: string, patch: Partial<AgentState>): boolean {
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
    agent.lastActivityAt = Date.now();
    return true;
  }

  resume(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'paused') return false;
    agent.status = 'active';
    agent.lastActivityAt = Date.now();
    return true;
  }

  stop(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.status = 'stopped';
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

  getMetrics() {
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

  countByStatus(status: AgentStatus): number {
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
}

export const agentRegistry = new AgentRegistry();