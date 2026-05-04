import { v4 as uuidv4 } from 'uuid';
import { agentRegistry } from './agent-registry.js';
import { agentOrchestrator } from './agent-orchestrator.js';
import type {
  AgentStatusResponse,
  AgentListResponse,
  SpawnOptions,
  ChatResponse,
} from './types.js';

export function registerAgentTools(): Array<{
  name: string;
  description: string;
  inputSchema: object;
}> {
  return [
    {
      name: 'agent_spawn',
      description: 'Spawn a new AI agent with specified lane and configuration',
      inputSchema: {
        type: 'object',
        properties: {
          lane: {
            type: 'string',
            enum: ['core', 'reviewer', 'qa', 'background'],
            description: 'Agent lane determining priority and resource allocation',
            default: 'core',
          },
          model: {
            type: 'string',
            description: 'Optional model identifier',
          },
          systemPrompt: {
            type: 'string',
            description: 'System prompt for agent behavior',
          },
          threadId: {
            type: 'string',
            description: 'Optional explicit thread ID',
          },
          metadata: {
            type: 'object',
            description: 'Additional metadata for the agent',
          },
        },
      },
    },
    {
      name: 'agent_list',
      description: 'List all active agents with their status, lane, and metrics',
      inputSchema: {
        type: 'object',
        properties: {
          lane: {
            type: 'string',
            enum: ['core', 'reviewer', 'qa', 'background'],
            description: 'Filter agents by lane',
          },
          status: {
            type: 'string',
            enum: ['active', 'paused', 'stopped', 'error'],
            description: 'Filter agents by status',
          },
        },
      },
    },
    {
      name: 'agent_status',
      description: 'Get detailed status for a specific agent',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent ID',
          },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'agent_chat',
      description: 'Send a message to an agent and receive a response',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent ID to send message to',
          },
          message: {
            type: 'string',
            description: 'Message content',
          },
          stream: {
            type: 'boolean',
            description: 'Enable streaming response',
            default: false,
          },
        },
        required: ['agentId', 'message'],
      },
    },
    {
      name: 'agent_pause',
      description: 'Pause an active agent',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent ID to pause',
          },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'agent_resume',
      description: 'Resume a paused agent',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent ID to resume',
          },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'agent_stop',
      description: 'Stop an agent permanently',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'Agent ID to stop',
          },
        },
        required: ['agentId'],
      },
    },
    {
      name: 'agent_metrics',
      description: 'Get aggregate metrics across all agents and lanes',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'orchestrator_configure',
      description: 'Configure the agent orchestrator with team settings',
      inputSchema: {
        type: 'object',
        properties: {
          preset: {
            type: 'string',
            enum: ['balanced', 'throughput', 'tokenSaver'],
            description: 'Team preset profile',
          },
          maxConcurrency: {
            type: 'number',
            description: 'Max concurrent agents',
          },
          reviewerLightMode: {
            type: 'boolean',
          },
          qaLightMode: {
            type: 'boolean',
          },
        },
      },
    },
  ];
}

export function handleAgentTool(
  toolName: string,
  args: Record<string, unknown>,
): { content: Array<{ type: string; text: string }> } {
  switch (toolName) {
    case 'agent_spawn': {
      const opts: SpawnOptions = {
        lane: (args.lane as SpawnOptions['lane']) || 'core',
        model: args.model as string,
        systemPrompt: args.systemPrompt as string,
        threadId: args.threadId as string,
        metadata: args.metadata as Record<string, unknown>,
      };
      const state = agentRegistry.spawn(opts);
      agentOrchestrator.acquire(state.lane, state.agentId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            agentId: state.agentId,
            threadId: state.threadId,
            lane: state.lane,
            status: state.status,
            createdAt: state.createdAt,
          }, null, 2),
        }],
      };
    }

    case 'agent_list': {
      const agents = agentRegistry.getAll();
      const filtered = agents.filter(a => {
        if (args.lane && a.lane !== args.lane) return false;
        if (args.status && a.status !== args.status) return false;
        return true;
      });
      const metrics = agentRegistry.getMetrics();
      const response: AgentListResponse = {
        agents: filtered.map(a => ({
          agentId: a.agentId,
          threadId: a.threadId,
          status: a.status,
          lane: a.lane,
          tokensIn: a.tokensIn,
          tokensOut: a.tokensOut,
          avgLatencyMs: a.avgLatencyMs,
          requestCount: a.requestCount,
          lastActivityAt: a.lastActivityAt,
          messageCount: a.messages.length,
        })),
        total: filtered.length,
        metrics,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }

    case 'agent_status': {
      const agent = agentRegistry.get(args.agentId as string);
      if (!agent) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }, null, 2) }],
        };
      }
      const response: AgentStatusResponse = {
        agentId: agent.agentId,
        threadId: agent.threadId,
        status: agent.status,
        lane: agent.lane,
        tokensIn: agent.tokensIn,
        tokensOut: agent.tokensOut,
        avgLatencyMs: agent.avgLatencyMs,
        requestCount: agent.requestCount,
        lastActivityAt: agent.lastActivityAt,
        messageCount: agent.messages.length,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }

    case 'agent_chat': {
      const { agentId, message } = args as { agentId: string; message: string };
      const agent = agentRegistry.get(agentId);
      if (!agent) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }, null, 2) }],
        };
      }
      const startLatency = Date.now();
      const userTokens = Math.ceil(message.length / 4);
      const assistantTokens = Math.ceil(message.length / 4);
      const userMsg = {
        id: uuidv4(),
        role: 'user' as const,
        content: message,
        timestamp: Date.now(),
        tokensIn: userTokens,
      };
      agentRegistry.addMessage(agentId, userMsg);
      const assistantMsg = {
        id: uuidv4(),
        role: 'assistant' as const,
        content: `[Agent ${agentId}] Message received on lane ${agent.lane}. This is a placeholder response.`,
        timestamp: Date.now(),
        tokensOut: assistantTokens,
      };
      agentRegistry.addMessage(agentId, assistantMsg);
      agentRegistry.recordLatency(agentId, Date.now() - startLatency);
      const response: ChatResponse = {
        success: true,
        response: assistantMsg.content,
        agentId,
        threadId: agent.threadId,
        tokensIn: userTokens,
        tokensOut: assistantTokens,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }

    case 'agent_pause': {
      const ok = agentRegistry.pause(args.agentId as string);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: ok, agentId: args.agentId }) }],
      };
    }

    case 'agent_resume': {
      const ok = agentRegistry.resume(args.agentId as string);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: ok, agentId: args.agentId }) }],
      };
    }

    case 'agent_stop': {
      const agent = agentRegistry.get(args.agentId as string);
      const ok = agentRegistry.stop(args.agentId as string);
      if (ok && agent) {
        agentOrchestrator.release(agent.lane, agent.agentId);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: ok, agentId: args.agentId }) }],
      };
    }

    case 'agent_metrics': {
      const metrics = agentRegistry.getMetrics();
      const orchestratorStats = agentOrchestrator.getStats();
      return {
        content: [{ type: 'text', text: JSON.stringify({ metrics, orchestrator: orchestratorStats }, null, 2) }],
      };
    }

    case 'orchestrator_configure': {
      if (args.preset) {
        agentOrchestrator.buildPreset(args.preset as 'balanced' | 'throughput' | 'tokenSaver');
      } else if (args.maxConcurrency !== undefined) {
        agentOrchestrator.configure({ maxConcurrency: args.maxConcurrency as number });
      } else {
        agentOrchestrator.fromPluginSettings({
          reviewerLightMode: args.reviewerLightMode as boolean,
          qaLightMode: args.qaLightMode as boolean,
        });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, config: agentOrchestrator.getProfile() }, null, 2) }],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }, null, 2) }],
      };
  }
}