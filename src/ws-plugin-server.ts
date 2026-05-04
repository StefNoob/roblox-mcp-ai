import { WebSocket, WebSocketServer as WSWebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { BridgeService } from './bridge-service.js';

export type WsMessageType =
  | 'chat'
  | 'task_control'
  | 'agent_status'
  | 'ping'
  | 'pong'
  | 'error'
  | 'subscribe'
  | 'task_event'
  | 'file_tree_delta'
  | 'orchestrator_selection';

export interface WsPluginMessage {
  type: WsMessageType;
  id?: string;
  payload?: unknown;
  sessionId?: string;
  agentId?: string;
  threadId?: string;
  taskId?: string;
  goalId?: string;
  timestamp?: number;
}

export interface WsPluginClient {
  id: string;
  sessionId: string;
  agentId?: string;
  ws: WebSocket;
  subscribedThreads: Set<string>;
  lastActivityAt: number;
  capabilities: Record<string, boolean>;
}

export type WsMessageHandler = (client: WsPluginClient, message: WsPluginMessage) => void;
export type WsConnectHandler = (client: WsPluginClient) => void;
export type WsDisconnectHandler = (client: WsPluginClient) => void;

export interface WsPluginServerOptions {
  port?: number;
  host?: string;
  bridge: BridgeService;
  onConnect?: WsConnectHandler;
  onDisconnect?: WsDisconnectHandler;
  onMessage?: WsMessageHandler;
}

export class WsPluginServer {
  private wss: WSWebSocketServer | null = null;
  private clients: Map<string, WsPluginClient> = new Map();
  private sessionClients: Map<string, Set<string>> = new Map();
  private bridge: BridgeService;
  private port: number;
  private host: string;
  private onConnect?: WsConnectHandler;
  private onDisconnect?: WsDisconnectHandler;
  private onMessage?: WsMessageHandler;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly HEARTBEAT_MS = 15000;
  private readonly CLIENT_TIMEOUT_MS = 30000;

  constructor(options: WsPluginServerOptions) {
    this.bridge = options.bridge;
    this.port = options.port ?? 3003;
    this.host = options.host ?? 'localhost';
    this.onConnect = options.onConnect;
    this.onDisconnect = options.onDisconnect;
    this.onMessage = options.onMessage;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WSWebSocketServer({ port: this.port, host: this.host });

        this.wss.on('listening', () => {
          this.startHeartbeat();
          resolve();
        });

        this.wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });

        this.wss.on('error', (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleConnection(ws: WebSocket, req: any): void {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const sessionId = url.searchParams.get('sessionId') || uuidv4().slice(0, 8);
    const agentId = url.searchParams.get('agentId') || undefined;

    const clientId = uuidv4();
    const client: WsPluginClient = {
      id: clientId,
      sessionId,
      agentId,
      ws,
      subscribedThreads: new Set(),
      lastActivityAt: Date.now(),
      capabilities: {},
    };

    this.clients.set(clientId, client);

    if (!this.sessionClients.has(sessionId)) {
      this.sessionClients.set(sessionId, new Set());
    }
    this.sessionClients.get(sessionId)!.add(clientId);

    ws.on('message', (data) => {
      this.handleMessage(client, data.toString());
    });

    ws.on('close', () => {
      this.handleDisconnect(client);
    });

    ws.on('error', () => {
      this.handleDisconnect(client);
    });

    this.sendToClient(client, {
      type: 'pong',
      id: uuidv4(),
      timestamp: Date.now(),
      payload: { clientId, sessionId }
    });

    this.onConnect?.(client);
  }

  private handleMessage(client: WsPluginClient, rawData: string): void {
    try {
      const message: WsPluginMessage = JSON.parse(rawData);
      client.lastActivityAt = Date.now();

      switch (message.type) {
        case 'ping':
          this.sendToClient(client, { type: 'pong', id: message.id, timestamp: Date.now() });
          break;

        case 'subscribe':
          if (message.threadId) {
            client.subscribedThreads.add(message.threadId);
          }
          this.sendToClient(client, {
            type: 'pong',
            id: message.id,
            timestamp: Date.now(),
            payload: { subscribed: Array.from(client.subscribedThreads) }
          });
          break;

        case 'chat':
          this.handleChatMessage(client, message);
          break;

        case 'task_control':
          this.handleTaskControl(client, message);
          break;

        case 'agent_status':
          this.handleAgentStatusRequest(client, message);
          break;

        default:
          this.onMessage?.(client, message);
          break;
      }
    } catch {
      this.sendToClient(client, {
        type: 'error',
        id: uuidv4(),
        timestamp: Date.now(),
        payload: { message: 'Invalid message format' }
      });
    }
  }

  private handleChatMessage(client: WsPluginClient, message: WsPluginMessage): void {
    const content = (message.payload as any)?.content || '';
    const threadId = message.threadId || (message.payload as any)?.threadId;
    const effectiveAgentId = message.agentId || client.agentId || 'default';

    if (!content) {
      this.sendToClient(client, {
        type: 'error',
        id: message.id,
        timestamp: Date.now(),
        payload: { message: 'Chat content is required' }
      });
      return;
    }

    let targetThreadId = threadId;
    if (!targetThreadId || !this.bridge.getAgentThread(targetThreadId)) {
      const newThread = this.bridge.createAgentThread(effectiveAgentId);
      targetThreadId = newThread.threadId;
    }

    const userMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'user' as const,
      content,
      timestamp: Date.now(),
      tokensIn: Math.ceil(content.length / 4),
    };

    this.bridge.addMessageToThread(targetThreadId, userMessage);

    const responseContent = `[WS AI Response] Messaggio ricevuto: "${content}". Latenza bassa via WebSocket.`;

    const assistantMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant' as const,
      content: responseContent,
      timestamp: Date.now(),
      tokensOut: Math.ceil(responseContent.length / 4),
    };

    this.bridge.addMessageToThread(targetThreadId, assistantMessage);

    this.sendToClient(client, {
      type: 'chat',
      id: message.id,
      threadId: targetThreadId,
      agentId: effectiveAgentId,
      timestamp: Date.now(),
      payload: {
        response: responseContent,
        tokensIn: userMessage.tokensIn,
        tokensOut: assistantMessage.tokensOut,
      }
    });

    this.broadcastToThreadSubscribers(targetThreadId, {
      type: 'chat',
      threadId: targetThreadId,
      agentId: effectiveAgentId,
      timestamp: Date.now(),
      payload: {
        message: assistantMessage,
      }
    }, client.id);
  }

  private handleTaskControl(client: WsPluginClient, message: WsPluginMessage): void {
    const action = (message.payload as any)?.action;
    const targetAgentId = message.agentId || (message.payload as any)?.agentId || 'default';
    const targetThreadId = message.threadId || (message.payload as any)?.threadId;

    let success = false;
    let affectedAgents: string[] = [];

    switch (action) {
      case 'pause':
        success = this.bridge.pauseAgent(targetAgentId);
        if (success) affectedAgents = [targetAgentId];
        break;
      case 'resume':
        success = this.bridge.resumeAgent(targetAgentId);
        if (success) affectedAgents = [targetAgentId];
        break;
      case 'stop':
        success = this.bridge.stopAgent(targetAgentId);
        if (success) affectedAgents = [targetAgentId];
        break;
      case 'cancel':
        if (targetThreadId) {
          const thread = this.bridge.getAgentThread(targetThreadId);
          if (thread) {
            thread.status = 'stopped';
            thread.lastActivityAt = Date.now();
            success = true;
            affectedAgents = [thread.agentId];
          }
        }
        break;
      default:
        this.sendToClient(client, {
          type: 'error',
          id: message.id,
          timestamp: Date.now(),
          payload: { message: `Unknown action: ${action}` }
        });
        return;
    }

    this.sendToClient(client, {
      type: 'task_control',
      id: message.id,
      timestamp: Date.now(),
      payload: { success, affectedAgents, action }
    });

    this.broadcastToSession(client.sessionId, {
      type: 'task_control',
      timestamp: Date.now(),
      payload: { success, affectedAgents, action, sourceClientId: client.id }
    }, client.id);
  }

  private handleAgentStatusRequest(client: WsPluginClient, message: WsPluginMessage): void {
    const agents = this.bridge.getAgentStatus();
    const metrics = this.bridge.getAgentMetrics();

    this.sendToClient(client, {
      type: 'agent_status',
      id: message.id,
      timestamp: Date.now(),
      payload: {
        agents,
        totalTokensIn: metrics.tokensInTotal,
        totalTokensOut: metrics.tokensOutTotal,
        activeAgentCount: agents.filter(a => a.status === 'active').length,
      }
    });
  }

  private handleDisconnect(client: WsPluginClient): void {
    this.clients.delete(client.id);

    const sessionClients = this.sessionClients.get(client.sessionId);
    if (sessionClients) {
      sessionClients.delete(client.id);
      if (sessionClients.size === 0) {
        this.sessionClients.delete(client.sessionId);
      }
    }

    this.onDisconnect?.(client);
  }

  private broadcastToThreadSubscribers(threadId: string, message: WsPluginMessage, excludeClientId?: string): void {
    const messageStr = JSON.stringify(message);
    for (const [clientId, client] of this.clients) {
      if (clientId !== excludeClientId && client.subscribedThreads.has(threadId)) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(messageStr);
        }
      }
    }
  }

  broadcastToSession(sessionId: string, message: WsPluginMessage, excludeClientId?: string): void {
    const clientIds = this.sessionClients.get(sessionId);
    if (!clientIds) return;

    const messageStr = JSON.stringify(message);
    for (const clientId of clientIds) {
      if (clientId !== excludeClientId) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(messageStr);
        }
      }
    }
  }

  broadcastToAll(message: WsPluginMessage, excludeClientId?: string): void {
    const messageStr = JSON.stringify(message);
    for (const [clientId, client] of this.clients) {
      if (clientId !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(messageStr);
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [clientId, client] of this.clients) {
        if (now - client.lastActivityAt > this.CLIENT_TIMEOUT_MS) {
          client.ws.close();
          this.clients.delete(clientId);
          continue;
        }
        if (client.ws.readyState === WebSocket.OPEN) {
          this.sendToClient(client, { type: 'ping', timestamp: now });
        }
      }
    }, this.HEARTBEAT_MS);
  }

  sendToClient(client: WsPluginClient, message: WsPluginMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  sendToSession(sessionId: string, message: WsPluginMessage): void {
    this.broadcastToSession(sessionId, message);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getSessionClientCount(sessionId: string): number {
    return this.sessionClients.get(sessionId)?.size ?? 0;
  }

  getClientsForSession(sessionId: string): WsPluginClient[] {
    const clientIds = this.sessionClients.get(sessionId);
    if (!clientIds) return [];
    return [...clientIds].map(id => this.clients.get(id)).filter(Boolean) as WsPluginClient[];
  }

  broadcastTaskEvent(event: { taskId: string; type: string; goalId: string; agentId: string; progress?: { current: number; total: number }; result?: unknown; error?: unknown; timestamp: number }, excludeClientId?: string): void {
    this.broadcastToAll({
      type: 'task_event',
      taskId: event.taskId,
      goalId: event.goalId,
      agentId: event.agentId,
      timestamp: event.timestamp,
      payload: event,
    }, excludeClientId);
  }

  broadcastFileTreeDelta(path: string, change: 'created' | 'modified' | 'deleted', node: unknown): void {
    this.broadcastToAll({
      type: 'file_tree_delta',
      timestamp: Date.now(),
      payload: { path, change, node },
    });
  }

  broadcastOrchestratorSelection(agentId: string, tier: string, teamId: string, lane: string, goalId: string): void {
    this.broadcastToAll({
      type: 'orchestrator_selection',
      agentId,
      timestamp: Date.now(),
      payload: { agentId, tier, teamId, lane, goalId },
    });
  }

  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.wss?.close();
    this.clients.clear();
    this.sessionClients.clear();
  }
}
