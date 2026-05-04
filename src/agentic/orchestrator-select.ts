import type { AgentTier } from './subscription-manager.js';

export type GoalComplexity = 'trivial' | 'simple' | 'complex';

export interface GoalContext {
  complexity: GoalComplexity;
  subsystem?: string;
  deadline?: number;
  tokenBudget?: number;
}

export interface AgentSelection {
  agentId: string;
  tier: AgentTier;
  teamId: string;
  lane: string;
  weight: number;
}

const CRITICAL_SUBSYSTEMS = new Set(['AI', 'Combat', 'Physics', 'Networking']);

const AGENT_IDS: Record<AgentTier, string> = {
  orchestrator: 'ato.orchestrator',
  senior: 'ato.senior',
  junior: 'ato.junior',
  observer: 'ato.observer',
};

const TEAM_IDS: Record<AgentTier, string> = {
  orchestrator: 'orchestrator',
  senior: 'senior',
  junior: 'junior',
  observer: 'observer',
};

const LANES: Record<AgentTier, string> = {
  orchestrator: 'core',
  senior: 'core',
  junior: 'core',
  observer: 'background',
};

const WEIGHTS: Record<AgentTier, number> = {
  orchestrator: 8,
  senior: 4,
  junior: 2,
  observer: 1,
};

export function selectOrchestrator(context: GoalContext): AgentSelection {
  const { complexity, subsystem } = context;
  const isCritical = subsystem ? CRITICAL_SUBSYSTEMS.has(subsystem) : false;

  let tier: AgentTier;
  if (complexity === 'trivial') {
    tier = 'observer';
  } else if (complexity === 'simple') {
    tier = isCritical ? 'senior' : 'junior';
  } else if (complexity === 'complex') {
    tier = isCritical ? 'orchestrator' : 'senior';
  } else {
    tier = 'senior';
  }

  return {
    agentId: AGENT_IDS[tier],
    tier,
    teamId: TEAM_IDS[tier],
    lane: LANES[tier],
    weight: WEIGHTS[tier],
  };
}

export function getAgentWeights(): Record<string, number> {
  return {
    'ato.orchestrator': WEIGHTS.orchestrator,
    'ato.senior': WEIGHTS.senior,
    'ato.junior': WEIGHTS.junior,
    'ato.observer': WEIGHTS.observer,
  };
}

export function getLaneForAgent(tier: AgentTier): string {
  return LANES[tier];
}

export function getTeamForAgent(tier: AgentTier): string {
  return TEAM_IDS[tier];
}
