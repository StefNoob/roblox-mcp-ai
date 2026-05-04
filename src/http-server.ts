import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer as WSWebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService } from './bridge-service.js';

export type StudioSessionState = {
  sessionId: string;
  ready: boolean;
  lastSeenAt: number;
  version: string | null;
  capabilities: Record<string, boolean>;
  serverUrl: string | null;
  placeId: number | null;
  placeName: string | null;
};

export type HttpServerSharedState = {
  pluginConnectedHint: boolean;
  mcpServerActive: boolean;
  lastMCPActivity: number;
  mcpServerStartTime: number;
  lastPluginActivity: number;
  latestPluginReport: {
    version: string | null;
    instanceId: string | null;
    capabilities: Record<string, boolean>;
    lastReportedAt: number;
  };
  studioSessions: Map<string, StudioSessionState>;
};

export function createHttpServerSharedState(): HttpServerSharedState {
  return {
    pluginConnectedHint: false,
    mcpServerActive: false,
    lastMCPActivity: 0,
    mcpServerStartTime: 0,
    lastPluginActivity: 0,
    latestPluginReport: {
      version: null,
      instanceId: null,
      capabilities: {},
      lastReportedAt: 0,
    },
    studioSessions: new Map(),
  };
}

export type WsPluginMessage = {
  type: 'chat' | 'task_control' | 'agent_status' | 'ping' | 'pong' | 'error' | 'subscribe' | 'broadcast';
  id?: string;
  payload?: unknown;
  sessionId?: string;
  agentId?: string;
  threadId?: string;
  timestamp?: number;
};

export type WsPluginClient = {
  id: string;
  sessionId: string;
  agentId?: string;
  ws: WebSocket;
  subscribedThreads: Set<string>;
  lastActivityAt: number;
  capabilities: Record<string, boolean>;
};

export function createHttpServer(
  tools: RobloxStudioTools,
  bridge: BridgeService,
  sharedState: HttpServerSharedState = createHttpServerSharedState(),
) {
  const app = express();
  let wsHeartbeatInterval: NodeJS.Timeout | null = null;
  let wsSetupTimeout: NodeJS.Timeout | null = null;
  const metricsHistory: Array<{ timestamp: number; bridge: ReturnType<BridgeService['getStats']> }> = [];
  const recentErrors: Array<{ timestamp: number; endpoint: string; message: string }> = [];
  const idempotencyCache = new Map<string, { statusCode: number; body: any; createdAt: number; expiresAt: number; endpoint: string }>();
  const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

  const serverCapabilities = {
    // These routes are still handled through fallback logic in Node tools;
    // the Studio plugin does not implement dedicated endpoints yet.
    setScriptSourceFast: false,
    batchScriptEdits: false,
    replaceScriptFunction: true,
    writeQueue: true,
    runtimeMetrics: true,
    capturePerformanceSnapshot: true,
    debugLogStreaming: true,
    luauDiagnostics: true,
    fullSourceReads: true,
    applyAndVerify: true,
    scriptSnapshots: true,
    driftCheck: true,
    idempotentWrites: true,
    sessionRouting: true,
    teamOrchestrator: true,
    websocket: true,
  };

  const wsClients: Map<string, WsPluginClient> = new Map();
  const wsSessionClients: Map<string, Set<string>> = new Map();

  const broadcastToThread = (threadId: string, message: WsPluginMessage, excludeClientId?: string) => {
    const msgStr = JSON.stringify(message);
    for (const [clientId, client] of wsClients) {
      if (clientId !== excludeClientId && client.subscribedThreads.has(threadId)) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(msgStr);
        }
      }
    }
  };

  const broadcastToSession = (sessionId: string, message: WsPluginMessage, excludeClientId?: string) => {
    const clientIds = wsSessionClients.get(sessionId);
    if (!clientIds) return;
    const msgStr = JSON.stringify(message);
    for (const clientId of clientIds) {
      if (clientId !== excludeClientId) {
        const client = wsClients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(msgStr);
        }
      }
    }
  };

  const broadcastToAll = (message: WsPluginMessage, excludeClientId?: string) => {
    const msgStr = JSON.stringify(message);
    for (const [clientId, client] of wsClients) {
      if (clientId !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msgStr);
      }
    }
  };

  const handleWsMessage = (client: WsPluginClient, data: string) => {
    try {
      const msg: WsPluginMessage = JSON.parse(data);
      client.lastActivityAt = Date.now();
      bridge.updatePluginClientActivity(client.id);

      switch (msg.type) {
        case 'ping':
          client.ws.send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: Date.now() }));
          break;

        case 'subscribe':
          if (msg.threadId) {
            client.subscribedThreads.add(msg.threadId);
            bridge.subscribePluginClientToThread(client.id, msg.threadId);
          }
          client.ws.send(JSON.stringify({
            type: 'pong',
            id: msg.id,
            timestamp: Date.now(),
            payload: { subscribed: Array.from(client.subscribedThreads) }
          }));
          break;

        case 'chat': {
          const content = (msg.payload as any)?.content || '';
          const threadId = msg.threadId || (msg.payload as any)?.threadId;
          const effectiveAgentId = msg.agentId || client.agentId || 'default';

          if (!content) {
            client.ws.send(JSON.stringify({
              type: 'error',
              id: msg.id,
              timestamp: Date.now(),
              payload: { message: 'Chat content is required' }
            }));
            break;
          }

          let targetThreadId = threadId;
          if (!targetThreadId || !bridge.getAgentThread(targetThreadId)) {
            const newThread = bridge.createAgentThread(effectiveAgentId);
            targetThreadId = newThread.threadId;
          }

          const userMsg = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'user' as const,
            content,
            timestamp: Date.now(),
            tokensIn: Math.ceil(content.length / 4),
          };

          bridge.addMessageToThread(targetThreadId, userMsg);

          const responseContent = `[WS Response] "${content}" - WebSocket bidirectional chat working.`;

          const assistantMsg = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            role: 'assistant' as const,
            content: responseContent,
            timestamp: Date.now(),
            tokensOut: Math.ceil(responseContent.length / 4),
          };

          bridge.addMessageToThread(targetThreadId, assistantMsg);

          client.ws.send(JSON.stringify({
            type: 'chat',
            id: msg.id,
            threadId: targetThreadId,
            agentId: effectiveAgentId,
            timestamp: Date.now(),
            payload: { response: responseContent, tokensIn: userMsg.tokensIn, tokensOut: assistantMsg.tokensOut }
          }));

          broadcastToThread(targetThreadId, {
            type: 'chat',
            threadId: targetThreadId,
            agentId: effectiveAgentId,
            timestamp: Date.now(),
            payload: { message: assistantMsg }
          }, client.id);
          break;
        }

        case 'task_control': {
          const action = (msg.payload as any)?.action;
          const targetAgentId = msg.agentId || (msg.payload as any)?.agentId || 'default';
          const targetThreadId = msg.threadId || (msg.payload as any)?.threadId;

          let success = false;
          let affectedAgents: string[] = [];

          switch (action) {
            case 'pause':
              success = bridge.pauseAgent(targetAgentId);
              if (success) affectedAgents = [targetAgentId];
              break;
            case 'resume':
              success = bridge.resumeAgent(targetAgentId);
              if (success) affectedAgents = [targetAgentId];
              break;
            case 'stop':
              success = bridge.stopAgent(targetAgentId);
              if (success) affectedAgents = [targetAgentId];
              break;
            case 'cancel':
              if (targetThreadId) {
                const thread = bridge.getAgentThread(targetThreadId);
                if (thread) {
                  thread.status = 'stopped';
                  thread.lastActivityAt = Date.now();
                  success = true;
                  affectedAgents = [thread.agentId];
                }
              }
              break;
            default:
              client.ws.send(JSON.stringify({
                type: 'error',
                id: msg.id,
                timestamp: Date.now(),
                payload: { message: `Unknown action: ${action}` }
              }));
              return;
          }

          client.ws.send(JSON.stringify({
            type: 'task_control',
            id: msg.id,
            timestamp: Date.now(),
            payload: { success, affectedAgents, action }
          }));

          broadcastToSession(client.sessionId, {
            type: 'task_control',
            timestamp: Date.now(),
            payload: { success, affectedAgents, action, sourceClientId: client.id }
          }, client.id);
          break;
        }

        case 'agent_status': {
          const agents = bridge.getAgentStatus();
          const metrics = bridge.getAgentMetrics();
          client.ws.send(JSON.stringify({
            type: 'agent_status',
            id: msg.id,
            timestamp: Date.now(),
            payload: {
              agents,
              totalTokensIn: metrics.tokensInTotal,
              totalTokensOut: metrics.tokensOutTotal,
              activeAgentCount: agents.filter(a => a.status === 'active').length,
            }
          }));
          break;
        }

        default:
          break;
      }
    } catch {
      client.ws.send(JSON.stringify({
        type: 'error',
        id: uuidv4(),
        timestamp: Date.now(),
        payload: { message: 'Invalid message format' }
      }));
    }
  };

  const writeEndpoints = new Set([
    'set_script_source',
    'set_script_source_checked',
    'set_script_source_fast',
    'set_script_source_fast_gzip',
    'commit_script_source_upload',
    'apply_and_verify_script_source',
    'rollback_script_snapshot',
    'batch_script_edits',
    'replace_script_function',
    'edit_script_lines',
    'insert_script_lines',
    'delete_script_lines',
    'set_property',
    'mass_set_property',
    'create_object',
    'create_object_with_properties',
    'mass_create_objects',
    'mass_create_objects_with_properties',
    'delete_object',
    'set_attribute',
    'delete_attribute',
    'add_tag',
    'remove_tag',
    'set_calculated_property',
    'set_relative_property',
    'smart_duplicate',
    'mass_duplicate',
    'import_instance_snapshot',
    'copy_instance_snapshot',
    'copy_instance_cross_session',
  ]);

  const readHeaderString = (value: string | string[] | undefined): string | null => {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
      return value[0];
    }
    return null;
  };

  const readObjectString = (value: unknown): string | null => {
    return typeof value === 'string' ? value : null;
  };

  const readObjectField = (body: Record<string, unknown> | null, key: string): unknown => {
    if (!body) {
      return undefined;
    }
    return body[key];
  };

  const coerceBodyObject = (value: unknown): { object: Record<string, unknown> | null; invalidJson: boolean } => {
    if (value === undefined || value === null || value === '') {
      return { object: null, invalidJson: false };
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return { object: value as Record<string, unknown>, invalidJson: false };
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return { object: null, invalidJson: false };
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { object: parsed as Record<string, unknown>, invalidJson: false };
        }
        return { object: null, invalidJson: true };
      } catch {
        return { object: null, invalidJson: true };
      }
    }
    return { object: null, invalidJson: true };
  };

  const parseCapabilitiesHeader = (raw: string | null): Record<string, boolean> | null => {
    if (!raw || raw.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const capabilities: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') {
          capabilities[key] = value;
        }
      }
      return capabilities;
    } catch {
      return null;
    }
  };

  const recordError = (endpoint: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    recentErrors.push({
      timestamp: Date.now(),
      endpoint,
      message,
    });
    if (recentErrors.length > 200) {
      recentErrors.shift();
    }
  };

  const sweepIdempotencyCache = () => {
    const now = Date.now();
    for (const [key, entry] of idempotencyCache.entries()) {
      if (now >= entry.expiresAt) {
        idempotencyCache.delete(key);
      }
    }
  };

  const getIdempotencyKey = (req: express.Request): string | null => {
    const header = readHeaderString(req.headers['x-idempotency-key']);
    const bodyObject = coerceBodyObject(req.body).object;
    const bodyKey = readObjectString(readObjectField(bodyObject, 'idempotencyKey'));
    const key = (header || bodyKey || '').trim();
    return key.length > 0 ? key : null;
  };

  const getWriteReadiness = (sessionId?: string | null) => {
    if (!isPluginConnected()) {
      if (isPluginPolling()) {
        return {
          ready: false,
          reason: 'Studio plugin is polling, but /ready handshake has not completed yet.',
        };
      }
      return { ready: false, reason: 'Plugin is not connected.' };
    }
    if (!isMCPServerActive()) {
      return { ready: false, reason: 'MCP server is not active.' };
    }
    if (Date.now() - sharedState.lastPluginActivity > 15000) {
      return { ready: false, reason: 'Plugin heartbeat is stale.' };
    }
    const readySessions = bridge.getStudioSessions().filter((session) => session.ready);
    if (!sessionId && readySessions.length > 1) {
      return { ready: false, reason: 'Multiple Studio sessions connected. Specify sessionId for write requests.' };
    }
    if (sessionId) {
      const target = bridge.getStudioSessions().find((session) => session.sessionId === sessionId);
      if (!target) {
        return { ready: false, reason: `Target session not found: ${sessionId}` };
      }
      if (!target.ready) {
        return { ready: false, reason: `Target session is not ready: ${sessionId}` };
      }
    }
    return { ready: true, reason: 'ready' };
  };

  const parsePlaceId = (value: unknown): number | null | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const normalized = Math.trunc(value);
      return normalized > 0 ? normalized : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        const normalized = Math.trunc(parsed);
        return normalized > 0 ? normalized : null;
      }
    }
    return undefined;
  };

  const parsePlaceName = (value: unknown): string | null | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return undefined;
  };

  const readQueryString = (value: unknown): string | null => {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
      return value[0];
    }
    return null;
  };

  const getSessionPlacePatch = (req: express.Request, body?: Record<string, unknown> | null): { placeId?: number | null; placeName?: string | null } => {
    const queryPlaceId = readQueryString(req.query?.placeId);
    const queryPlaceName = readQueryString(req.query?.placeName);
    const headerPlaceId = readHeaderString(req.headers['x-mcp-place-id']);
    const headerPlaceName = readHeaderString(req.headers['x-mcp-place-name']);
    const placeId = parsePlaceId(readObjectField(body ?? null, 'placeId') ?? queryPlaceId ?? headerPlaceId);
    const placeName = parsePlaceName(readObjectField(body ?? null, 'placeName') ?? queryPlaceName ?? headerPlaceName);
    return {
      ...(placeId !== undefined ? { placeId } : {}),
      ...(placeName !== undefined ? { placeName } : {}),
    };
  };

  const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    const n = Math.trunc(value);
    return Math.max(min, Math.min(max, n));
  };

  const normalizeLaneWeights = (raw: unknown): Record<string, number> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    const out: Record<string, number> = {};
    for (const [lane, weight] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof lane !== 'string' || lane.trim().length === 0) {
        continue;
      }
      out[lane.trim()] = clampInt(weight, 1, 12, 1);
    }
    return out;
  };

  const isVerboseFlag = (value: unknown) => {
    if (value === true) return true;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  };

  const isVerboseRequest = (req: express.Request) => {
    const bodyObject = coerceBodyObject(req.body).object;
    return isVerboseFlag(req.query?.verbose) || isVerboseFlag(readObjectField(bodyObject, 'verbose'));
  };

  const getBridgeStats = (verbose: boolean) => {
    const stats = bridge.getStats();
    if (verbose) {
      return stats;
    }
    const { endpoints, ...rest } = stats as any;
    return rest;
  };

  const getSessionPayload = (verbose: boolean) => {
    const sessions = bridge.getStudioSessions();
    if (verbose) {
      return sessions;
    }
    return sessions.slice(0, 3).map((session) => ({
      sessionId: session.sessionId,
      ready: session.ready,
      lastSeenAt: session.lastSeenAt,
      version: session.version ?? null,
      placeId: session.placeId ?? null,
      placeName: session.placeName ?? null,
    }));
  };

  const getRecentErrorsPayload = (verbose: boolean) => {
    const limit = verbose ? 50 : 5;
    return recentErrors.slice(Math.max(0, recentErrors.length - limit));
  };

  const applyTeamOrchestratorProfile = (rawProfile: unknown) => {
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
      return;
    }
    const profile = rawProfile as Record<string, unknown>;
    const rawTeams = profile.teams;
    const teams: Record<string, { lane?: string; maxInFlight?: number; tokenMode?: 'standard' | 'light'; weight?: number }> = {};
    if (rawTeams && typeof rawTeams === 'object' && !Array.isArray(rawTeams)) {
      for (const [teamId, rawPolicy] of Object.entries(rawTeams as Record<string, unknown>)) {
        if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
          continue;
        }
        const policy = rawPolicy as Record<string, unknown>;
        teams[teamId] = {
          lane: typeof policy.lane === 'string' ? policy.lane : undefined,
          maxInFlight: clampInt(policy.maxInFlight, 1, 16, 1),
          tokenMode: policy.tokenMode === 'light' ? 'light' : 'standard',
          weight: clampInt(policy.weight, 1, 12, 1),
        };
      }
    }
    tools.configureTeamOrchestrator({
      maxConcurrency: clampInt(profile.maxConcurrency, 1, 16, 2),
      defaultTeamId: typeof profile.defaultTeamId === 'string' ? profile.defaultTeamId : undefined,
      laneWeights: normalizeLaneWeights(profile.laneWeights),
      teams,
    });
  };

  const getWriteSessionTarget = (endpoint: string, req: express.Request): string | null => {
    const body = coerceBodyObject(req.body).object;
    if (endpoint === 'copy_instance_cross_session') {
      return readObjectString(readObjectField(body, 'targetSessionId'));
    }
    if (endpoint === 'import_instance_snapshot') {
      return readObjectString(readObjectField(body, 'targetSessionId'));
    }
    if (endpoint === 'copy_instance_snapshot') {
      const options = readObjectField(body, 'options');
      if (options && typeof options === 'object' && !Array.isArray(options)) {
        const optionTarget = readObjectString((options as Record<string, unknown>).targetSessionId);
        if (optionTarget) return optionTarget;
      }
      const bodyTarget = readObjectString(readObjectField(body, 'targetSessionId'));
      if (bodyTarget) return bodyTarget;
    }
    const sessionId = readObjectString(readObjectField(body, 'sessionId'));
    if (sessionId) {
      return sessionId;
    }
    return null;
  };

  const updateLatestPluginReport = (patch: {
    version?: string | null;
    instanceId?: string | null;
    capabilities?: Record<string, boolean>;
  }) => {
    let touched = false;
    if (patch.version !== undefined) {
      sharedState.latestPluginReport.version = patch.version;
      touched = true;
    }
    if (patch.instanceId !== undefined) {
      sharedState.latestPluginReport.instanceId = patch.instanceId;
      touched = true;
    }
    if (patch.capabilities !== undefined) {
      sharedState.latestPluginReport.capabilities = patch.capabilities;
      touched = true;
    }
    if (touched) {
      sharedState.latestPluginReport.lastReportedAt = Date.now();
    }
  };

  const getPluginStatusPayload = () => ({
    ready: isPluginConnected(),
    polling: isPluginPolling(),
    version: sharedState.latestPluginReport.version,
    instanceId: sharedState.latestPluginReport.instanceId,
    capabilities: sharedState.latestPluginReport.capabilities,
    lastReportedAt: sharedState.latestPluginReport.lastReportedAt,
  });

  // Track MCP server lifecycle
  const setMCPServerActive = (active: boolean) => {
    sharedState.mcpServerActive = active;
    if (active) {
      sharedState.mcpServerStartTime = Date.now();
      sharedState.lastMCPActivity = Date.now();
    } else {
      sharedState.mcpServerStartTime = 0;
      sharedState.lastMCPActivity = 0;
    }
  };

  const trackMCPActivity = () => {
    if (sharedState.mcpServerActive) {
      sharedState.lastMCPActivity = Date.now();
    }
  };

  const isMCPServerActive = () => {
    if (!sharedState.mcpServerActive) return false;
    const now = Date.now();
    const mcpRecent = (now - sharedState.lastMCPActivity) < 15000;
    const pluginPollingRecent = (now - sharedState.lastPluginActivity) < 15000;
    // Consider bridge connected if MCP had recent activity OR plugin is polling (reconnect after Studio restart)
    return mcpRecent || pluginPollingRecent;
  };

  const isPluginConnected = () => {
    const hasFreshReadySession = freshSessions().some((session) => session.ready);
    return hasFreshReadySession || (sharedState.pluginConnectedHint && (Date.now() - sharedState.lastPluginActivity < 10000));
  };

  const getSessionIdFromRequest = (req: express.Request, body?: Record<string, unknown> | null): string | null => {
    const querySid = (readQueryString(req.query?.sid) || '').trim();
    if (querySid) return querySid;
    const querySessionId = (readQueryString(req.query?.sessionId) || '').trim();
    if (querySessionId) return querySessionId;
    const queryPluginId = (readQueryString(req.query?.pluginInstanceId) || '').trim();
    if (queryPluginId) return queryPluginId;
    const bodySid = (readObjectString(readObjectField(body ?? null, 'sessionId')) || '').trim();
    if (bodySid) return bodySid;
    const pluginSid = (readObjectString(readObjectField(body ?? null, 'pluginInstanceId')) || '').trim();
    if (pluginSid) return pluginSid;
    const headerSid = readHeaderString(req.headers['x-mcp-session-id']) || readHeaderString(req.headers['x-mcp-plugin-instance-id']);
    const normalized = (headerSid || '').trim();
    return normalized.length > 0 ? normalized : null;
  };

  const upsertSession = (
    sessionId: string,
    patch: Partial<Omit<StudioSessionState, 'sessionId' | 'lastSeenAt'>> & { lastSeenAt?: number },
  ) => {
    const existing = sharedState.studioSessions.get(sessionId);
    const next: StudioSessionState = {
      sessionId,
      ready: patch.ready ?? existing?.ready ?? false,
      lastSeenAt: patch.lastSeenAt ?? Date.now(),
      version: patch.version ?? existing?.version ?? null,
      capabilities: patch.capabilities ?? existing?.capabilities ?? {},
      serverUrl: patch.serverUrl ?? existing?.serverUrl ?? null,
      placeId: patch.placeId ?? existing?.placeId ?? null,
      placeName: patch.placeName ?? existing?.placeName ?? null,
    };
    sharedState.studioSessions.set(sessionId, next);
    bridge.upsertStudioSession(sessionId, {
      sessionId,
      ready: next.ready,
      lastSeenAt: next.lastSeenAt,
      version: next.version,
      capabilities: next.capabilities,
      serverUrl: next.serverUrl,
      placeId: next.placeId,
      placeName: next.placeName,
    });
  };

  const markSessionDisconnected = (sessionId: string) => {
    const existing = sharedState.studioSessions.get(sessionId);
    if (!existing) {
      return;
    }
    const next: StudioSessionState = {
      ...existing,
      ready: false,
      lastSeenAt: Date.now(),
    };
    sharedState.studioSessions.set(sessionId, next);
    bridge.markStudioSessionDisconnected(sessionId);
    bridge.clearPendingRequestsForSession(sessionId);
    if (freshSessions().every((session) => !session.ready)) {
      sharedState.pluginConnectedHint = false;
    }
  };

  const freshSessions = (maxAgeMs: number = 10000) => {
    const now = Date.now();
    return [...sharedState.studioSessions.values()].filter((session) => now - session.lastSeenAt < maxAgeMs);
  };

  const isPluginPolling = () => {
    return freshSessions().length > 0 || (Date.now() - sharedState.lastPluginActivity < 10000);
  };

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({ limit: '50mb', type: ['text/plain', 'text/json', 'application/x-json'] }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use(((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof SyntaxError && 'body' in error) {
      recordError((req.originalUrl || req.url || '').split('?')[0] || '/unknown', error);
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    next(error);
  }) as express.ErrorRequestHandler);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      service: 'robloxstudio-mcp',
      pluginConnected: isPluginConnected(),
      mcpServerActive: isMCPServerActive(),
      uptime: sharedState.mcpServerActive ? Date.now() - sharedState.mcpServerStartTime : 0,
      bridge: bridge.getStats(),
      plugin: getPluginStatusPayload(),
      serverCapabilities,
      websocket: {
        enabled: true,
        path: '/ws/plugin',
        clientCount: wsClients.size,
        sessionCount: wsSessionClients.size,
      }
    });
  });

  // Plugin readiness endpoint
  app.post('/ready', (req, res) => {
    const bodyState = coerceBodyObject(req.body);
    if (bodyState.invalidJson) {
      recordError('/ready', 'Invalid JSON body');
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    const body = bodyState.object ?? {};
    const sessionId = getSessionIdFromRequest(req, body);
    if (!sessionId) {
      recordError('/ready', 'Invalid ready payload');
      res.status(400).json({ error: 'Invalid ready payload. sessionId is required.' });
      return;
    }
    sharedState.pluginConnectedHint = true;
    sharedState.lastPluginActivity = Date.now();
    updateLatestPluginReport({
      version: readObjectString(body.version) ?? undefined,
      instanceId: readObjectString(body.pluginInstanceId) ?? undefined,
    });
    if (body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)) {
      updateLatestPluginReport({ capabilities: body.capabilities as Record<string, boolean> });
    }
    if (body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile)) {
      const profile = body.profile as Record<string, unknown>;
      if (profile.teamOrchestrator && typeof profile.teamOrchestrator === 'object') {
        applyTeamOrchestratorProfile(profile.teamOrchestrator);
      } else {
        applyTeamOrchestratorProfile({
          maxConcurrency: profile.parallelAgents,
          defaultTeamId: 'core',
          laneWeights: { core: 3, reviewer: 1, qa: 1, background: 1 },
          teams: {
            core: {
              lane: 'core',
              maxInFlight: profile.parallelAgents,
              tokenMode: profile.useLightModel === true ? 'light' : 'standard',
              weight: 3,
            },
            reviewer: {
              lane: 'reviewer',
              maxInFlight: 1,
              tokenMode: 'light',
              weight: 1,
            },
            qa: {
              lane: 'qa',
              maxInFlight: 1,
              tokenMode: 'light',
              weight: 1,
            },
            background: {
              lane: 'background',
              maxInFlight: 1,
              tokenMode: profile.useLightModel === true ? 'light' : 'standard',
              weight: 1,
            },
          },
        });
      }
    }
    if (sessionId) {
      const placePatch = getSessionPlacePatch(req, body);
      upsertSession(sessionId, {
        ready: true,
        version: sharedState.latestPluginReport.version,
        capabilities: sharedState.latestPluginReport.capabilities,
        serverUrl: readObjectString(body.serverUrl),
        ...placePatch,
      });
    }
    res.json({ success: true });
  });

  // Plugin disconnect endpoint
  app.post('/disconnect', (req, res) => {
    const bodyState = coerceBodyObject(req.body);
    if (bodyState.invalidJson) {
      recordError('/disconnect', 'Invalid JSON body');
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    const sessionId = getSessionIdFromRequest(req, bodyState.object);
    if (sessionId) {
      markSessionDisconnected(sessionId);
    } else {
      const activeSessions = freshSessions().filter((session) => session.ready);
      if (activeSessions.length > 1) {
        res.status(409).json({
          success: false,
          error: 'Multiple Studio sessions are active. Provide sessionId when disconnecting.',
        });
        return;
      }
      if (activeSessions.length === 1) {
        markSessionDisconnected(activeSessions[0].sessionId);
      } else {
        sharedState.pluginConnectedHint = false;
        bridge.clearAllPendingRequests();
      }
    }
    if (freshSessions().every((session) => !session.ready)) {
      sharedState.pluginConnectedHint = false;
    }
    res.json({ success: true });
  });

  // Enhanced status endpoint
  app.get('/status', (req, res) => {
    res.json({ 
      pluginConnected: isPluginConnected(),
      mcpServerActive: isMCPServerActive(),
      lastMCPActivity: sharedState.lastMCPActivity,
      uptime: sharedState.mcpServerActive ? Date.now() - sharedState.mcpServerStartTime : 0,
      sessions: bridge.getStudioSessions(),
      bridge: bridge.getStats(),
      plugin: getPluginStatusPayload(),
      serverCapabilities
    });
  });

  app.get('/sessions', (req, res) => {
    res.json({
      status: 'ok',
      count: bridge.getStudioSessions().length,
      sessions: bridge.getStudioSessions(),
    });
  });

  app.get('/metrics', (req, res) => {
    const bridgeStats = bridge.getStats();
    metricsHistory.push({ timestamp: Date.now(), bridge: bridgeStats });
    if (metricsHistory.length > 720) {
      metricsHistory.shift();
    }
    res.json({
      status: 'ok',
      generatedAt: Date.now(),
      bridge: bridgeStats,
      plugin: {
        connected: isPluginConnected(),
        ...getPluginStatusPayload(),
      },
      serverCapabilities
    });
  });

  app.get('/diagnostics', async (req, res) => {
    try {
      const verbose = isVerboseRequest(req);
      sweepIdempotencyCache();
      const toolDiagnostics = await tools.getDiagnostics(verbose);
      let runtimePayload: any = {};
      try {
        const firstContent = Array.isArray((toolDiagnostics as any).content) ? (toolDiagnostics as any).content[0] : null;
        if (firstContent?.text) {
          runtimePayload = JSON.parse(firstContent.text);
        }
      } catch {
        runtimePayload = {};
      }

      res.json({
        status: 'ok',
        generatedAt: Date.now(),
        mcpServerActive: isMCPServerActive(),
        pluginConnected: isPluginConnected(),
        readiness: getWriteReadiness(),
        plugin: {
          connected: isPluginConnected(),
          ...getPluginStatusPayload(),
        },
        idempotency: {
          entries: idempotencyCache.size,
          ttlMs: IDEMPOTENCY_TTL_MS,
        },
        recentErrors: getRecentErrorsPayload(verbose),
        bridge: getBridgeStats(verbose),
        writeQueue: tools.getWriteQueueStats({ verbose }),
        serverCapabilities,
        runtime: runtimePayload.runtime ?? {},
        snapshots: runtimePayload.snapshots ?? {},
      });
    } catch (error) {
      recordError('/diagnostics', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get('/metrics/history', (req, res) => {
    res.json({
      status: 'ok',
      points: metricsHistory.length,
      history: metricsHistory
    });
  });

  // Enhanced polling endpoint for Studio plugin
  app.get('/poll', (req, res) => {
    const queryVersion = typeof req.query?.v === 'string' ? req.query.v : null;
    const queryCapabilitiesRaw = typeof req.query?.caps === 'string' ? req.query.caps : null;
    let manualVersion: string | null = null;
    let manualCapabilitiesRaw: string | null = null;
    try {
      const rawUrl = req.originalUrl || req.url || '';
      const queryStart = rawUrl.indexOf('?');
      if (queryStart >= 0 && queryStart < rawUrl.length - 1) {
        const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
        manualVersion = params.get('v');
        manualCapabilitiesRaw = params.get('caps');
      }
    } catch {
      // Ignore malformed query and continue with express parsed query/header sources.
    }
    const headerVersion = readHeaderString(req.headers['x-mcp-plugin-version']);
    const candidateVersion = queryVersion || manualVersion || headerVersion;
    if (candidateVersion) {
      updateLatestPluginReport({ version: candidateVersion });
    }
    const sessionId = getSessionIdFromRequest(req);
    const queryInstanceId = readQueryString(req.query?.sid) || readQueryString(req.query?.sessionId) || readQueryString(req.query?.pluginInstanceId);
    if (queryInstanceId) {
      updateLatestPluginReport({ instanceId: queryInstanceId });
    }
    const headerCapabilitiesRaw = readHeaderString(req.headers['x-mcp-plugin-capabilities']);
    const candidateCapabilities = parseCapabilitiesHeader(queryCapabilitiesRaw || manualCapabilitiesRaw || headerCapabilitiesRaw);
    if (candidateCapabilities && Object.keys(candidateCapabilities).length > 0) {
      updateLatestPluginReport({ capabilities: candidateCapabilities });
    }
    sharedState.lastPluginActivity = Date.now();
    if (sessionId) {
      const placePatch = getSessionPlacePatch(req);
      upsertSession(sessionId, {
        version: sharedState.latestPluginReport.version,
        capabilities: sharedState.latestPluginReport.capabilities,
        ...placePatch,
      });
    }
    // Refresh MCP activity on every poll so that after Studio reconnects (e.g. was closed),
    // the first poll makes isMCPServerActive() true again and the bridge reconnects.
    trackMCPActivity();
    
    if (!isMCPServerActive()) {
      res.status(503).json({ 
        error: 'MCP server not connected',
        pluginConnected: isPluginConnected(),
        mcpConnected: false,
        request: null,
        plugin: getPluginStatusPayload(),
        serverCapabilities
      });
      return;
    }
    
    trackMCPActivity();
    
    const pendingRequest = bridge.getPendingRequest(sessionId || undefined);
    if (pendingRequest) {
      const recentTasks = bridge.getRecentTaskUpdates?.() ?? [];
      res.json({
        request: pendingRequest.request,
        requestId: pendingRequest.requestId,
        mcpConnected: true,
        pluginConnected: isPluginConnected(),
        sessionId: sessionId || null,
        plugin: getPluginStatusPayload(),
        serverCapabilities,
        tasks: recentTasks,
        fileTreeDeltas: []
      });
    } else {
      const recentTasks = bridge.getRecentTaskUpdates?.() ?? [];
      res.json({
        request: null,
        mcpConnected: true,
        pluginConnected: isPluginConnected(),
        sessionId: sessionId || null,
        plugin: getPluginStatusPayload(),
        serverCapabilities,
        tasks: recentTasks,
        fileTreeDeltas: []
      });
    }
  });

  // Response endpoint for Studio plugin
  app.post('/response', (req, res) => {
    const bodyState = coerceBodyObject(req.body);
    if (bodyState.invalidJson) {
      recordError('/response', 'Invalid JSON body');
      res.status(400).json({ success: false, error: 'Invalid JSON body' });
      return;
    }
    const body = bodyState.object;
    const requestId = readObjectString(readObjectField(body, 'requestId'))?.trim() ?? '';
    if (!requestId) {
      recordError('/response', 'Invalid response payload');
      res.status(400).json({ success: false, error: 'Invalid response payload' });
      return;
    }
    const response = readObjectField(body, 'response');
    const error = readObjectField(body, 'error');
    const sessionId = getSessionIdFromRequest(req, body);

    const validation = bridge.validateResponseSession(requestId, sessionId || undefined);
    if (!validation.ok) {
      recordError('/response', validation.reason);
      res.status(409).json({ success: false, error: validation.reason });
      return;
    }

    if (sessionId) {
      const placePatch = getSessionPlacePatch(req, body);
      upsertSession(sessionId, {
        version: sharedState.latestPluginReport.version,
        capabilities: sharedState.latestPluginReport.capabilities,
        ...placePatch,
      });
    }
    
    if (error) {
      recordError('/response', error);
      bridge.rejectRequest(requestId, error);
    } else {
      bridge.resolveRequest(requestId, response);
    }
    
    res.json({ success: true });
  });

  // Middleware to track MCP activity for all MCP endpoints
  app.use('/mcp/*', (req, res, next) => {
    const bodyState = coerceBodyObject(req.body);
    if (bodyState.invalidJson) {
      recordError((req.originalUrl || req.url || '').split('?')[0] || '/mcp', 'Invalid JSON body');
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    if (bodyState.object) {
      const wrappedArgs = readObjectField(bodyState.object, 'arguments');
      if (wrappedArgs !== undefined) {
        if (!wrappedArgs || typeof wrappedArgs !== 'object' || Array.isArray(wrappedArgs)) {
          recordError((req.originalUrl || req.url || '').split('?')[0] || '/mcp', 'Invalid MCP arguments payload');
          res.status(400).json({ error: 'Invalid MCP arguments payload' });
          return;
        }
        req.body = {
          ...bodyState.object,
          ...(wrappedArgs as Record<string, unknown>),
        };
        delete (req.body as Record<string, unknown>).arguments;
      } else {
        req.body = bodyState.object;
      }
    } else {
      req.body = {};
    }
    trackMCPActivity();
    sweepIdempotencyCache();
    const fromBase = `${req.baseUrl || ''}${req.path || ''}`.split('?')[0] || '';
    const originalPath = (req.originalUrl || req.url || '').split('?')[0] || '';
    const selectedPath = fromBase.startsWith('/mcp/') ? fromBase : originalPath;
    const endpoint = selectedPath
      .replace(/^\/mcp\//, '')
      .replace(/\/+$/, '')
      .replace(/^\//, '');
    if (writeEndpoints.has(endpoint)) {
      const readiness = getWriteReadiness(getWriteSessionTarget(endpoint, req));
      if (!readiness.ready) {
        recordError(`/mcp/${endpoint}`, readiness.reason);
        res.status(503).json({ error: readiness.reason, endpoint, readiness });
        return;
      }
    }
    const key = getIdempotencyKey(req);
    if (req.method === 'POST' && key && writeEndpoints.has(endpoint)) {
      const composite = `${endpoint}:${key}`;
      const cached = idempotencyCache.get(composite);
      if (cached && Date.now() < cached.expiresAt) {
        res.status(cached.statusCode).json({
          ...cached.body,
          idempotency: {
            replayed: true,
            key,
            createdAt: cached.createdAt,
          }
        });
        return;
      }
      const originalJson = res.json.bind(res);
      (res as any).json = (body: any) => {
        if (res.statusCode < 500) {
          idempotencyCache.set(composite, {
            statusCode: res.statusCode,
            body,
            createdAt: Date.now(),
            expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
            endpoint,
          });
        }
        return originalJson(body);
      };
    }
    next();
  });

  // MCP tool proxy endpoints - these will be called by AI tools
  app.post('/mcp/get_file_tree', async (req, res) => {
    try {
      const result = await tools.getFileTree(req.body.path);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });


  app.post('/mcp/search_files', async (req, res) => {
    try {
      const result = await tools.searchFiles(req.body.query, req.body.searchType);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });


  app.post('/mcp/get_place_info', async (req, res) => {
    try {
      const result = await tools.getPlaceInfo();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_services', async (req, res) => {
    try {
      const result = await tools.getServices(req.body.serviceName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });


  app.post('/mcp/search_objects', async (req, res) => {
    try {
      const result = await tools.searchObjects(req.body.query, req.body.searchType, req.body.propertyName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_instance_properties', async (req, res) => {
    try {
      const result = await tools.getInstanceProperties(req.body.instancePath, req.body.includeSource);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/list_studio_sessions', async (req, res) => {
    try {
      const result = tools.listStudioSessions(req.body?.maxAgeMs);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_instance_children', async (req, res) => {
    try {
      const result = await tools.getInstanceChildren(req.body.instancePath);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/export_instance_snapshot', async (req, res) => {
    try {
      const result = await tools.exportInstanceSnapshot(req.body.instancePath, {
        includeScripts: req.body.includeScripts,
        maxDepth: req.body.maxDepth,
      }, req.body.sourceSessionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/import_instance_snapshot', async (req, res) => {
    try {
      const result = await tools.importInstanceSnapshot(
        req.body.transferId,
        req.body.targetParentPath,
        req.body.options,
        req.body.targetSessionId,
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/copy_instance_snapshot', async (req, res) => {
    try {
      const result = await tools.copyInstanceSnapshot(req.body.sourceInstancePath, req.body.targetParentPath, req.body.options);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/copy_instance_cross_session', async (req, res) => {
    try {
      const result = await tools.copyInstanceCrossSession(
        req.body.sourceSessionId,
        req.body.targetSessionId,
        req.body.sourceInstancePath,
        req.body.targetParentPath,
        req.body.options,
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/list_instance_snapshot_transfers', async (_req, res) => {
    try {
      const result = tools.listInstanceSnapshotTransfers();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/delete_instance_snapshot_transfer', async (req, res) => {
    try {
      const result = tools.deleteInstanceSnapshotTransfer(req.body.transferId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/search_by_property', async (req, res) => {
    try {
      const result = await tools.searchByProperty(req.body.propertyName, req.body.propertyValue);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_class_info', async (req, res) => {
    try {
      const result = await tools.getClassInfo(req.body.className);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/mass_set_property', async (req, res) => {
    try {
      const result = await tools.massSetProperty(req.body.paths, req.body.propertyName, req.body.propertyValue);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/mass_get_property', async (req, res) => {
    try {
      const result = await tools.massGetProperty(req.body.paths, req.body.propertyName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/create_object_with_properties', async (req, res) => {
    try {
      const result = await tools.createObjectWithProperties(req.body.className, req.body.parent, req.body.name, req.body.properties);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/mass_create_objects', async (req, res) => {
    try {
      const result = await tools.massCreateObjects(req.body.objects);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/mass_create_objects_with_properties', async (req, res) => {
    try {
      const result = await tools.massCreateObjectsWithProperties(req.body.objects);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_project_structure', async (req, res) => {
    try {
      const result = await tools.getProjectStructure(req.body.path, req.body.maxDepth, req.body.scriptsOnly);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_structure_map_summary', async (req, res) => {
    try {
      const result = await tools.getStructureMapSummary();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/query_structure_map', async (req, res) => {
    try {
      const result = await tools.queryStructureMap(req.body.filters, req.body.mode);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/refresh_structure_map', async (req, res) => {
    try {
      const result = await tools.refreshStructureMap();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_script_inventory', async (req, res) => {
    try {
      const result = await tools.getScriptInventory(req.body.mode);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/explain_script_cached', async (req, res) => {
    try {
      const result = await tools.explainScriptCached(req.body.instancePath);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_subsystem_summary', async (req, res) => {
    try {
      const result = await tools.getSubsystemSummary(req.body.subsystem);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Script management endpoints (parity with tools)
  app.post('/mcp/get_script_source', async (req, res) => {
    try {
      const result = await tools.getScriptSource(req.body.instancePath, req.body.startLine, req.body.endLine);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_script_snapshot', async (req, res) => {
    try {
      const result = await tools.getScriptSnapshot(req.body.instancePath, req.body.startLine, req.body.endLine);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/begin_script_source_upload', async (req, res) => {
    try {
      const result = await tools.beginScriptSourceUpload(req.body.instancePath, req.body.expectedHash, req.body.mode);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/append_script_source_upload_chunk', async (req, res) => {
    try {
      const result = await tools.appendScriptSourceUploadChunk(req.body.uploadId, req.body.chunk, req.body.chunkIndex);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/commit_script_source_upload', async (req, res) => {
    try {
      const result = await tools.commitScriptSourceUpload(
        req.body.uploadId,
        req.body.verifyNeedle,
        req.body.rollbackOnFailure,
        req.body.preferFast,
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/cancel_script_source_upload', async (req, res) => {
    try {
      const result = await tools.cancelScriptSourceUpload(req.body.uploadId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/set_script_source', async (req, res) => {
    try {
      const result = await tools.setScriptSource(req.body.instancePath, req.body.source, req.body.expectedHash);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/set_script_source_checked', async (req, res) => {
    try {
      const result = await tools.setScriptSourceChecked(req.body.instancePath, req.body.source, req.body.expectedHash);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/set_script_source_fast', async (req, res) => {
    try {
      const result = await tools.setScriptSourceFast(req.body.instancePath, req.body.source, req.body.verify);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/set_script_source_fast_gzip', async (req, res) => {
    try {
      const result = await tools.setScriptSourceFastGzip(req.body.instancePath, req.body.sourceGzipBase64, req.body.verify);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/batch_script_edits', async (req, res) => {
    try {
      const result = await tools.batchScriptEdits(
        req.body.instancePath,
        req.body.operations,
        req.body.expectedHash,
        req.body.rollbackOnFailure,
        req.body.fastMode
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_selection', async (req, res) => {
    try {
      const result = await tools.getSelection();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/execute_luau', async (req, res) => {
    try {
      const result = await tools.executeLuau(req.body.code);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_runtime_state', async (req, res) => {
    try {
      const verbose = isVerboseRequest(req);
      res.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pluginConnected: isPluginConnected(),
              mcpServerActive: isMCPServerActive(),
              pluginVersion: sharedState.latestPluginReport.version,
              pluginCapabilities: sharedState.latestPluginReport.capabilities,
              pluginLastReportedAt: sharedState.latestPluginReport.lastReportedAt,
              sessions: getSessionPayload(verbose),
              sessionCount: bridge.getStudioSessions().length,
              serverCapabilities,
              writeQueue: tools.getWriteQueueStats({ verbose }),
              bridge: getBridgeStats(verbose)
            }, null, 2)
          }
        ]
      });
    } catch (error) {
      recordError('/mcp/get_runtime_state', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_diagnostics', async (req, res) => {
    try {
      const verbose = isVerboseRequest(req);
      sweepIdempotencyCache();
      const toolDiagnostics = await tools.getDiagnostics(verbose);
      let runtimePayload: any = {};
      try {
        const firstContent = Array.isArray((toolDiagnostics as any).content) ? (toolDiagnostics as any).content[0] : null;
        if (firstContent?.text) {
          runtimePayload = JSON.parse(firstContent.text);
        }
      } catch {
        runtimePayload = {};
      }
      res.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              readiness: getWriteReadiness(),
              plugin: {
                connected: isPluginConnected(),
                ...getPluginStatusPayload(),
              },
              idempotency: {
                entries: idempotencyCache.size,
                ttlMs: IDEMPOTENCY_TTL_MS,
              },
              recentErrors: getRecentErrorsPayload(verbose),
              sessions: getSessionPayload(verbose),
              sessionCount: bridge.getStudioSessions().length,
              bridge: getBridgeStats(verbose),
              writeQueue: tools.getWriteQueueStats({ verbose }),
              runtime: runtimePayload.runtime,
              snapshots: runtimePayload.snapshots,
            }, null, 2)
          }
        ]
      });
    } catch (error) {
      recordError('/mcp/get_diagnostics', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/check_script_drift', async (req, res) => {
    try {
      const result = await tools.checkScriptDrift(req.body.mappings, req.body.normalizeLineEndings);
      res.json(result);
    } catch (error) {
      recordError('/mcp/check_script_drift', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/lint_deprecated_apis', async (req, res) => {
    try {
      const result = await tools.lintDeprecatedApis(req.body.rootPath);
      res.json(result);
    } catch (error) {
      recordError('/mcp/lint_deprecated_apis', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/create_script_snapshot', async (req, res) => {
    try {
      const result = await tools.createScriptSnapshot(req.body.instancePath, req.body.label);
      res.json(result);
    } catch (error) {
      recordError('/mcp/create_script_snapshot', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/list_script_snapshots', async (req, res) => {
    try {
      const result = await tools.listScriptSnapshots(req.body.instancePath);
      res.json(result);
    } catch (error) {
      recordError('/mcp/list_script_snapshots', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/rollback_script_snapshot', async (req, res) => {
    try {
      const result = await tools.rollbackScriptSnapshot(req.body.snapshotId, req.body.verify);
      res.json(result);
    } catch (error) {
      recordError('/mcp/rollback_script_snapshot', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/apply_and_verify_script_source', async (req, res) => {
    try {
      const result = await tools.applyAndVerifyScriptSource(
        req.body.instancePath,
        req.body.source,
        req.body.expectedHash,
        req.body.verifyNeedle,
        req.body.rollbackOnFailure,
        req.body.preferFast,
      );
      res.json(result);
    } catch (error) {
      recordError('/mcp/apply_and_verify_script_source', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/cancel_pending_writes', async (req, res) => {
    try {
      const result = tools.cancelPendingWrites(req.body?.prefix);
      res.json({
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
    } catch (error) {
      recordError('/mcp/cancel_pending_writes', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Property modification endpoint
  app.post('/mcp/set_property', async (req, res) => {
    try {
      const result = await tools.setProperty(req.body.instancePath, req.body.propertyName, req.body.propertyValue);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Object creation/deletion endpoints
  app.post('/mcp/create_object', async (req, res) => {
    try {
      const result = await tools.createObject(req.body.className, req.body.parent, req.body.name);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/delete_object', async (req, res) => {
    try {
      const result = await tools.deleteObject(req.body.instancePath);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Smart duplication endpoints
  app.post('/mcp/smart_duplicate', async (req, res) => {
    try {
      const result = await tools.smartDuplicate(req.body.instancePath, req.body.count, req.body.options);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/mass_duplicate', async (req, res) => {
    try {
      const result = await tools.massDuplicate(req.body.duplications);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Calculated/relative property endpoints
  app.post('/mcp/set_calculated_property', async (req, res) => {
    try {
      const result = await tools.setCalculatedProperty(req.body.paths, req.body.propertyName, req.body.formula, req.body.variables);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/set_relative_property', async (req, res) => {
    try {
      const result = await tools.setRelativeProperty(req.body.paths, req.body.propertyName, req.body.operation, req.body.value, req.body.component);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Partial script editing endpoints
  app.post('/mcp/edit_script_lines', async (req, res) => {
    try {
      const result = await tools.editScriptLines(req.body.instancePath, req.body.startLine, req.body.endLine, req.body.newContent);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/insert_script_lines', async (req, res) => {
    try {
      const result = await tools.insertScriptLines(req.body.instancePath, req.body.afterLine, req.body.newContent);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/delete_script_lines', async (req, res) => {
    try {
      const result = await tools.deleteScriptLines(req.body.instancePath, req.body.startLine, req.body.endLine);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/replace_script_function', async (req, res) => {
    try {
      const result = await tools.replaceScriptFunction(
        req.body.instancePath,
        req.body.functionName,
        req.body.newFunctionContent,
        req.body.expectedHash,
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_luau_diagnostics', async (req, res) => {
    try {
      const result = await tools.getLuauDiagnostics({
        instancePaths: req.body.instancePaths,
        includeSourceHints: req.body.includeSourceHints,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Attribute endpoints
  app.post('/mcp/get_attribute', async (req, res) => {
    try {
      const result = await tools.getAttribute(req.body.instancePath, req.body.attributeName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/set_attribute', async (req, res) => {
    try {
      const result = await tools.setAttribute(req.body.instancePath, req.body.attributeName, req.body.attributeValue, req.body.valueType);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_attributes', async (req, res) => {
    try {
      const result = await tools.getAttributes(req.body.instancePath);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/delete_attribute', async (req, res) => {
    try {
      const result = await tools.deleteAttribute(req.body.instancePath, req.body.attributeName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Tag (CollectionService) endpoints
  app.post('/mcp/get_tags', async (req, res) => {
    try {
      const result = await tools.getTags(req.body.instancePath);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/add_tag', async (req, res) => {
    try {
      const result = await tools.addTag(req.body.instancePath, req.body.tagName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/remove_tag', async (req, res) => {
    try {
      const result = await tools.removeTag(req.body.instancePath, req.body.tagName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_tagged', async (req, res) => {
    try {
      const result = await tools.getTagged(req.body.tagName);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/start_playtest', async (req, res) => {
    try {
      const result = await tools.startPlaytest(req.body.mode);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/stop_playtest', async (req, res) => {
    try {
      const result = await tools.stopPlaytest();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_playtest_output', async (req, res) => {
    try {
      const result = await tools.getPlaytestOutput();
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // AI Player Control Endpoints
  app.post('/mcp/ai_control_player', async (req, res) => {
    try {
      const result = await tools.aiControlPlayer(req.body.action, req.body.duration, req.body.speed);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/ai_get_player_state', async (req, res) => {
    try {
      const result = await tools.aiGetPlayerState(req.body.includeNearby, req.body.nearbyRadius);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/ai_interact_with_object', async (req, res) => {
    try {
      const result = await tools.aiInteractWithObject(req.body.objectPath, req.body.action, req.body.playerIndex);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/ai_teleport_player', async (req, res) => {
    try {
      const result = await tools.aiTeleportPlayer(req.body.position, req.body.rotation, req.body.playerIndex);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_game_state', async (req, res) => {
    try {
      const result = await tools.getGameState(req.body.scope, req.body.maxResults);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/capture_debug_logs', async (req, res) => {
    try {
      const result = await tools.captureDebugLogs(req.body.type, req.body.maxLines, req.body.sinceTimestamp);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/open_debug_log_stream', async (req, res) => {
    try {
      const result = await tools.openDebugLogStream(req.body.type);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/poll_debug_log_stream', async (req, res) => {
    try {
      const result = await tools.pollDebugLogStream(req.body.cursorId, req.body.maxLines);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/close_debug_log_stream', async (req, res) => {
    try {
      const result = await tools.closeDebugLogStream(req.body.cursorId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_runtime_errors', async (req, res) => {
    try {
      const result = await tools.getRuntimeErrors(req.body.clearAfter);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/execute_test_sequence', async (req, res) => {
    try {
      const result = await tools.executeTestSequence(req.body.steps, req.body.stopOnError);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/watch_property_changes', async (req, res) => {
    try {
      const result = await tools.watchPropertyChanges(req.body.instancePath, req.body.properties, req.body.duration);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_performance_metrics', async (req, res) => {
    try {
      const result = await tools.getPerformanceMetrics(req.body.category);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/capture_performance_snapshot', async (req, res) => {
    try {
      const result = await tools.capturePerformanceSnapshot(req.body.category, req.body.sampleCount, req.body.intervalMs);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/inspect_terrain', async (req, res) => {
    try {
      const result = await tools.inspectTerrain(req.body.region, req.body.includeNavmesh);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/get_network_stats', async (req, res) => {
    try {
      const result = await tools.getNetworkStats(req.body.includePlayers);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/simulate_input', async (req, res) => {
    try {
      const result = await tools.simulateInput(req.body.inputType, req.body.target, req.body.position, req.body.keyCode);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/generate_ui', async (req, res) => {
    try {
      const result = await tools.generateUI(req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/mcp/preview_ui', async (req, res) => {
    try {
      const result = await tools.previewUI(req.body);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/api/agent/chat', async (req, res) => {
    try {
      const body = coerceBodyObject(req.body).object;
      const message = readObjectString(body?.message) || '';
      const agentId = readObjectString(body?.agentId) || 'default';
      const threadId = readObjectString(body?.threadId);
      let targetThreadId = threadId;
      if (!targetThreadId || !bridge.getAgentThread(targetThreadId)) {
        const newThread = bridge.createAgentThread(agentId);
        targetThreadId = newThread.threadId;
      }
      const userMessage: import('./bridge-service.js').ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: message,
        timestamp: Date.now(),
        tokensIn: Math.ceil(message.length / 4),
      };
      bridge.addMessageToThread(targetThreadId, userMessage);
      const responseContent = `[AI Response] Messaggio ricevuto: "${message}". In questa build i provider esterni sono disabilitati.`;
      const assistantMessage: import('./bridge-service.js').ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: responseContent,
        timestamp: Date.now(),
        tokensOut: Math.ceil(responseContent.length / 4),
      };
      bridge.addMessageToThread(targetThreadId, assistantMessage);
      res.json({
        success: true,
        response: responseContent,
        agentId,
        threadId: targetThreadId,
        tokensIn: userMessage.tokensIn,
        tokensOut: assistantMessage.tokensOut,
      });
    } catch (error) {
      recordError('/api/agent/chat', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get('/api/agent/status', (req, res) => {
    try {
      const agents = bridge.getAgentStatus();
      const metrics = bridge.getAgentMetrics();
      res.json({
        agents,
        totalTokensIn: metrics.tokensInTotal,
        totalTokensOut: metrics.tokensOutTotal,
        activeAgentCount: agents.filter(a => a.status === 'active').length,
      });
    } catch (error) {
      recordError('/api/agent/status', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/api/agent/control', async (req, res) => {
    try {
      const body = coerceBodyObject(req.body).object;
      const action = readObjectString(body?.action) || '';
      const agentId = readObjectString(body?.agentId) || 'default';
      let success = false;
      let affectedAgents: string[] = [];
      if (action === 'pause') {
        success = bridge.pauseAgent(agentId);
        if (success) affectedAgents = [agentId];
      } else if (action === 'resume') {
        success = bridge.resumeAgent(agentId);
        if (success) affectedAgents = [agentId];
      } else if (action === 'stop') {
        success = bridge.stopAgent(agentId);
        if (success) affectedAgents = [agentId];
      } else {
        res.status(400).json({ error: `Unknown action: ${action}` });
        return;
      }
      res.json({ success, affectedAgents });
    } catch (error) {
      recordError('/api/agent/control', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get('/api/agent/threads', (req, res) => {
    try {
      const threads = bridge.getAgentThreads();
      res.json({
        threads: threads.map(t => ({
          threadId: t.threadId,
          agentId: t.agentId,
          status: t.status,
          messageCount: t.messages.length,
          createdAt: t.createdAt,
          lastActivityAt: t.lastActivityAt,
        })),
      });
    } catch (error) {
      recordError('/api/agent/threads', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get('/api/agent/metrics', (req, res) => {
    try {
      res.json(bridge.getAgentMetrics());
    } catch (error) {
      recordError('/api/agent/metrics', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get('/api/agent/messages/:threadId', (req, res) => {
    try {
      const threadId = req.params?.threadId;
      if (!threadId) {
        res.status(400).json({ error: 'threadId is required' });
        return;
      }
      const messages = bridge.getThreadMessages(threadId);
      res.json({ threadId, messages });
    } catch (error) {
      recordError('/api/agent/messages', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.get('/api/agent/list', (req, res) => {
    try {
      const agents = bridge.getAgentStatus();
      const metrics = bridge.getAgentMetrics();
      res.json({
        agents,
        total: agents.length,
        totalTokensIn: metrics.tokensInTotal,
        totalTokensOut: metrics.tokensOutTotal,
        activeAgentCount: agents.filter(a => a.status === 'active').length,
        metrics,
      });
    } catch (error) {
      recordError('/api/agent/list', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  const setupWebSocketServer = (server: http.Server) => {
    const address = server.address();
    const serverPort = typeof address === 'string' ? 0 : (address?.port || 0);
    const wss = new WSWebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}:${serverPort}`);
      const pathname = url.pathname;

      if (pathname === '/ws/plugin' || pathname === '/ws/agent') {
        wss.handleUpgrade(request, socket as any, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
      const url = new URL(request.url || '/', `http://localhost:${serverPort}`);
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

      wsClients.set(clientId, client);

      if (!wsSessionClients.has(sessionId)) {
        wsSessionClients.set(sessionId, new Set());
      }
      wsSessionClients.get(sessionId)!.add(clientId);

      bridge.upsertPluginClient(clientId, {
        clientId,
        sessionId,
        agentId,
        connectedAt: Date.now(),
        lastActivityAt: Date.now(),
        capabilities: {},
        subscribedThreads: new Set(),
      });

      ws.send(JSON.stringify({
        type: 'pong',
        id: uuidv4(),
        timestamp: Date.now(),
        payload: { clientId, sessionId, agentId: agentId || null }
      }));

      ws.on('message', (data: Buffer) => {
        handleWsMessage(client, data.toString());
      });

      ws.on('close', () => {
        wsClients.delete(clientId);
        const sessionClients = wsSessionClients.get(sessionId);
        if (sessionClients) {
          sessionClients.delete(clientId);
          if (sessionClients.size === 0) {
            wsSessionClients.delete(sessionId);
          }
        }
        bridge.removePluginClient(clientId);
      });

      ws.on('error', () => {
        wsClients.delete(clientId);
        bridge.removePluginClient(clientId);
      });
    });

    wsHeartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [clientId, client] of wsClients) {
        if (now - client.lastActivityAt > 30000) {
          client.ws.close();
          wsClients.delete(clientId);
          bridge.removePluginClient(clientId);
        } else if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'ping', timestamp: now }));
        }
      }
    }, 15000);
    wsHeartbeatInterval.unref?.();

    (app as any).wsBroadcastToSession = (sessionId: string, message: WsPluginMessage) => {
      broadcastToSession(sessionId, message);
    };
    (app as any).wsBroadcastToAll = (message: WsPluginMessage) => {
      broadcastToAll(message);
    };
    (app as any).wsClientCount = () => wsClients.size;
    (app as any).wsGetClients = () => [...wsClients.values()].map(c => ({
      id: c.id,
      sessionId: c.sessionId,
      agentId: c.agentId,
      lastActivityAt: c.lastActivityAt,
      subscribedThreads: Array.from(c.subscribedThreads),
    }));

    return wss;
  };

  const maybeSetupWs = () => {
    const server = (app as any)._server;
    if (server && !((app as any)._wsServer)) {
      (app as any)._wsServer = setupWebSocketServer(server);
    }
  };

  wsSetupTimeout = setTimeout(maybeSetupWs, 1000);
  wsSetupTimeout.unref?.();

  const closeServerResources = () => {
    if (wsSetupTimeout) {
      clearTimeout(wsSetupTimeout);
      wsSetupTimeout = null;
    }
    if (wsHeartbeatInterval) {
      clearInterval(wsHeartbeatInterval);
      wsHeartbeatInterval = null;
    }
    const wsServer = (app as any)._wsServer as WSWebSocketServer | undefined;
    if (wsServer) {
      for (const client of wsClients.values()) {
        try {
          client.ws.close();
        } catch {
          // best-effort cleanup for tests
        }
      }
      wsServer.close();
      (app as any)._wsServer = undefined;
    }
    wsClients.clear();
    wsSessionClients.clear();
  };

  // Add methods to control and check server status
  (app as any).isPluginConnected = isPluginConnected;
  (app as any).setMCPServerActive = setMCPServerActive;
  (app as any).isMCPServerActive = isMCPServerActive;
  (app as any).trackMCPActivity = trackMCPActivity;
  (app as any).closeServerResources = closeServerResources;

  return app;
}
