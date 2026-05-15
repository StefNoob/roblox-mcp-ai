import { jest } from '@jest/globals';
import request from 'supertest';
import { createHttpServer, createHttpServerSharedState } from '../http-server';
import { RobloxStudioTools } from '../tools/index';
import { BridgeService } from '../bridge-service';
import { Application } from 'express';
import { WebSocket } from 'ws';

describe('HTTP Server', () => {
  let app: Application & any;
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new BridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge);
  });

  afterEach(() => {
    app.closeServerResources?.();
    bridge.clearAllPendingRequests();
  });

  describe('Health Check', () => {
    test('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'robloxstudio-mcp',
        pluginConnected: false,
        mcpServerActive: false
      });
    });
  });

  describe('WebSocket Agent Cockpit', () => {
    test('should accept /ws/agent upgrades after app.listen', async () => {
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));

      try {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent?sessionId=studio-a&agentId=codex`);
          const timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error('Timed out waiting for WebSocket greeting'));
          }, 3000);

          ws.once('message', (data) => {
            clearTimeout(timeout);
            const message = JSON.parse(data.toString());
            expect(message.type).toBe('pong');
            expect(message.payload).toMatchObject({
              sessionId: 'studio-a',
              agentId: 'codex',
            });
            ws.close();
            resolve();
          });

          ws.once('error', (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
    });
  });

  describe('Plugin Connection Management', () => {
    test('should return structured 400 for malformed JSON bodies', async () => {
      const response = await request(app)
        .post('/ready')
        .set('Content-Type', 'application/json')
        .send('{"sessionId":"studio-a"')
        .expect(400);

      expect(response.body).toEqual({
        error: 'Invalid JSON body',
      });
    });

    test('should handle plugin ready notification', async () => {
      const response = await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a' })
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(true);
    });

    test('should coerce JSON string bodies for ready handshake requests', async () => {
      const response = await request(app)
        .post('/ready')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ pluginInstanceId: 'studio-a', sessionId: 'studio-a' }))
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(true);

      const status = await request(app).get('/status').expect(200);
      expect(status.body.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 'studio-a', ready: true }),
        ]),
      );
    });

    test('should apply team orchestrator profile from plugin ready payload', async () => {
      await request(app)
        .post('/ready')
        .send({
          pluginInstanceId: 'studio-a',
          sessionId: 'studio-a',
          profile: {
            teamOrchestrator: {
              maxConcurrency: 3,
              defaultTeamId: 'core',
              laneWeights: {
                core: 4,
                reviewer: 1,
                qa: 1,
              },
              teams: {
                core: { lane: 'core', maxInFlight: 3, tokenMode: 'standard', weight: 4 },
                reviewer: { lane: 'reviewer', maxInFlight: 1, tokenMode: 'light', weight: 1 },
                qa: { lane: 'qa', maxInFlight: 1, tokenMode: 'light', weight: 1 },
              },
            },
          },
        })
        .expect(200);

      const queue = tools.getWriteQueueStats() as any;
      expect(queue.maxConcurrency).toBe(3);
      expect(queue.laneWeights.core).toBe(4);
      expect(queue.teamStats.reviewer.tokenMode).toBe('light');
      expect(queue.teamStats.reviewer.maxInFlight).toBe(1);
    });

    test('should handle plugin disconnect', async () => {

      await request(app).post('/ready').send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a' }).expect(200);
      expect(app.isPluginConnected()).toBe(true);

      const response = await request(app)
        .post('/disconnect')
        .send({ sessionId: 'studio-a' })
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(false);
    });

    test('should coerce JSON string bodies for disconnect requests', async () => {
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a' })
        .expect(200);

      const response = await request(app)
        .post('/disconnect')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ sessionId: 'studio-a' }))
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(false);
    });

    test('should clear pending requests on disconnect', async () => {

      const p1 = bridge.sendRequest('/api/test1', {});
      const p2 = bridge.sendRequest('/api/test2', {});
      p1.catch(() => {});
      p2.catch(() => {});

      expect(bridge.getPendingRequest()).toBeTruthy();

      await request(app).post('/disconnect').expect(200);

      expect(bridge.getPendingRequest()).toBeNull();
    });

    test('should reject unscoped disconnect when multiple studio sessions are active', async () => {
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a' })
        .expect(200);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-b', sessionId: 'studio-b' })
        .expect(200);

      const targetPromise = bridge.sendRequest('/api/test-target', {}, { sessionId: 'studio-b' });
      targetPromise.catch(() => {});

      const response = await request(app)
        .post('/disconnect')
        .send({})
        .expect(409);

      expect(response.body.error).toMatch(/multiple studio sessions/i);
      expect(bridge.getPendingRequest('studio-b')).toBeTruthy();
    });

    test('should timeout plugin connection after inactivity', async () => {

      await request(app).post('/ready').send({ pluginInstanceId: 'test', sessionId: 'test' }).expect(200);
      expect(app.isPluginConnected()).toBe(true);

      const originalDateNow = Date.now;
      Date.now = jest.fn(() => originalDateNow() + 11000);

      expect(app.isPluginConnected()).toBe(false);

      Date.now = originalDateNow;
    });
  });

  describe('Shared Session State', () => {
    test('should share plugin session presence across main and legacy listeners', async () => {
      const sharedState = createHttpServerSharedState();
      const mainApp = createHttpServer(tools, bridge, sharedState) as Application & any;
      const legacyApp = createHttpServer(tools, bridge, sharedState) as Application & any;

      legacyApp.setMCPServerActive(true);

      await request(legacyApp)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a', version: '2.0.0' })
        .expect(200);

      expect(mainApp.isPluginConnected()).toBe(true);

      const mainStatus = await request(mainApp).get('/status').expect(200);
      expect(mainStatus.body.pluginConnected).toBe(true);
      expect(mainStatus.body.plugin.version).toBe('2.0.0');
      expect(mainStatus.body.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 'studio-a', ready: true }),
        ]),
      );
    });
  });

  describe('Polling Endpoint', () => {
    test('should mark plugin as polling but not ready until /ready completes', async () => {
      app.setMCPServerActive(true);

      const response = await request(app)
        .get('/poll')
        .query({ sid: 'studio-a' })
        .expect(200);

      expect(response.body.pluginConnected).toBe(false);
      expect(response.body.plugin.ready).toBe(false);

      const health = await request(app).get('/health').expect(200);
      expect(health.body.pluginConnected).toBe(false);
      expect(health.body.plugin.ready).toBe(false);
      expect(health.body.plugin.polling).toBe(true);
    });

    test('should explain readiness as pending ready handshake when plugin is only polling', async () => {
      app.setMCPServerActive(true);

      await request(app)
        .get('/poll')
        .query({ sid: 'studio-a' })
        .expect(200);

      const diagnostics = await request(app).get('/diagnostics').expect(200);
      expect(diagnostics.body.readiness).toEqual({
        ready: false,
        reason: 'Studio plugin is polling, but /ready handshake has not completed yet.',
      });
    });

    test('should return 503 when MCP server is not active', async () => {
      const response = await request(app)
        .get('/poll')
        .expect(503);

      expect(response.body).toMatchObject({
        error: 'MCP server not connected',
        pluginConnected: false,
        mcpConnected: false,
        request: null
      });
      expect(response.body.plugin.ready).toBe(false);
      expect(response.body.plugin.polling).toBe(true);
    });

    test('should return pending request when MCP is active', async () => {

      app.setMCPServerActive(true);

      const pendingRequest = bridge.sendRequest('/api/test', { data: 'test' });
      pendingRequest.catch(() => {});

      const response = await request(app)
        .get('/poll')
        .expect(200);

      expect(response.body).toMatchObject({
        request: {
          endpoint: '/api/test',
          data: { data: 'test' }
        },
        mcpConnected: true,
        pluginConnected: false
      });
      expect(response.body.requestId).toBeTruthy();
      expect(response.body.plugin.ready).toBe(false);
      expect(response.body.plugin.polling).toBe(true);
    });

    test('should return null request when no pending requests', async () => {

      app.setMCPServerActive(true);

      const response = await request(app)
        .get('/poll')
        .expect(200);

      expect(response.body).toMatchObject({
        request: null,
        mcpConnected: true,
        pluginConnected: false
      });
      expect(response.body.plugin.ready).toBe(false);
      expect(response.body.plugin.polling).toBe(true);
    });

    test('should mark plugin as polling but not ready when polling', async () => {
      expect(app.isPluginConnected()).toBe(false);

      await request(app).get('/poll').expect(503);

      expect(app.isPluginConnected()).toBe(false);
    });

    test('should capture plugin version and capabilities from poll headers', async () => {
      const capabilities = {
        setScriptSourceFast: true,
        batchScriptEdits: true
      };

      await request(app)
        .get('/poll')
        .set('X-MCP-Plugin-Version', '1.9.1')
        .set('X-MCP-Plugin-Capabilities', JSON.stringify(capabilities))
        .expect(503);

      const health = await request(app).get('/health').expect(200);
      expect(health.body.plugin.version).toBe('1.9.1');
      expect(health.body.plugin.capabilities).toEqual(capabilities);
      expect(health.body.plugin.lastReportedAt).toBeGreaterThan(0);
      expect(health.body.pluginConnected).toBe(false);
      expect(health.body.plugin.ready).toBe(false);
      expect(health.body.plugin.polling).toBe(true);
    });

    test('should capture plugin version and capabilities from poll query params', async () => {
      const capabilities = {
        fullSourceReads: true,
        adaptivePolling: true
      };

      await request(app)
        .get('/poll')
        .query({
          v: '1.9.1',
          caps: JSON.stringify(capabilities)
        })
        .expect(503);

      const health = await request(app).get('/health').expect(200);
      expect(health.body.plugin.version).toBe('1.9.1');
      expect(health.body.plugin.capabilities).toEqual(capabilities);
      expect(health.body.plugin.lastReportedAt).toBeGreaterThan(0);
      expect(health.body.pluginConnected).toBe(false);
      expect(health.body.plugin.ready).toBe(false);
      expect(health.body.plugin.polling).toBe(true);
    });

    test('should capture place metadata from poll headers for session status', async () => {
      app.setMCPServerActive(true);

      await request(app)
        .get('/poll')
        .query({ sid: 'studio-a' })
        .set('X-MCP-Place-Id', '987654')
        .set('X-MCP-Place-Name', 'Poll Place')
        .expect(200);

      const sessionsResponse = await request(app).get('/sessions').expect(200);
      const studioSession = sessionsResponse.body.sessions.find((session: any) => session.sessionId === 'studio-a');
      expect(studioSession?.placeId).toBe(987654);
      expect(studioSession?.placeName).toBe('Poll Place');
    });

    test('should accept sessionId query alias when polling', async () => {
      app.setMCPServerActive(true);

      const response = await request(app)
        .get('/poll')
        .query({ sessionId: 'studio-query' })
        .expect(200);

      expect(response.body.sessionId).toBe('studio-query');

      const sessionsResponse = await request(app).get('/sessions').expect(200);
      expect(sessionsResponse.body.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 'studio-query' }),
        ]),
      );
    });

    test('should route pending requests by session id', async () => {
      app.setMCPServerActive(true);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-source', sessionId: 'studio-source' })
        .expect(200);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-target', sessionId: 'studio-target' })
        .expect(200);

      const sourcePromise = bridge.sendRequest('/api/source-only', { id: 1 }, { sessionId: 'studio-source' });
      sourcePromise.catch(() => {});
      const targetPromise = bridge.sendRequest('/api/target-only', { id: 2 }, { sessionId: 'studio-target' });
      targetPromise.catch(() => {});

      const targetPoll = await request(app)
        .get('/poll')
        .query({ sid: 'studio-target' })
        .expect(200);
      expect(targetPoll.body.request.endpoint).toBe('/api/target-only');

      const sourcePoll = await request(app)
        .get('/poll')
        .query({ sid: 'studio-source' })
        .expect(200);
      expect(sourcePoll.body.request.endpoint).toBe('/api/source-only');

      await request(app)
        .post('/response')
        .send({ requestId: targetPoll.body.requestId, sessionId: 'studio-target', response: { ok: true } })
        .expect(200);
      await request(app)
        .post('/response')
        .send({ requestId: sourcePoll.body.requestId, sessionId: 'studio-source', response: { ok: true } })
        .expect(200);

      await expect(targetPromise).resolves.toEqual({ ok: true });
      await expect(sourcePromise).resolves.toEqual({ ok: true });
    });
  });

  describe('Response Handling', () => {
    test('should return 400 for response payloads missing requestId after coercion', async () => {
      const requestPromise = bridge.sendRequest('/api/test', {}, { sessionId: 'studio-a' });
      requestPromise.catch(() => {});
      bridge.getPendingRequest('studio-a');

      const response = await request(app)
        .post('/response')
        .set('Content-Type', 'text/plain')
        .set('x-mcp-session-id', 'studio-a')
        .send(JSON.stringify({
          response: { result: 'success' },
        }))
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid response payload',
      });
    });

    test('should handle successful response', async () => {
      const responseData = { result: 'success' };

      const requestPromise = bridge.sendRequest('/api/test', {});
      const pendingRequest = bridge.getPendingRequest();

      const response = await request(app)
        .post('/response')
        .send({
          requestId: pendingRequest!.requestId,
          response: responseData
        })
        .expect(200);

      expect(response.body).toEqual({ success: true });

      const result = await requestPromise;
      expect(result).toEqual(responseData);
    });

    test('should handle error response', async () => {
      const error = 'Test error message';

      const requestPromise = bridge.sendRequest('/api/test', {});
      requestPromise.catch(() => {});
      const pendingRequest = bridge.getPendingRequest();

      const response = await request(app)
        .post('/response')
        .send({
          requestId: pendingRequest!.requestId,
          error: error
        })
        .expect(200);

      expect(response.body).toEqual({ success: true });

      await expect(requestPromise).rejects.toEqual(error);
    });

    test('should reject a response from a different studio session than the one that leased the request', async () => {
      app.setMCPServerActive(true);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-source', sessionId: 'studio-source' })
        .expect(200);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-target', sessionId: 'studio-target' })
        .expect(200);

      const requestPromise = bridge.sendRequest('/api/source-only', { id: 1 }, { sessionId: 'studio-source' });
      requestPromise.catch(() => {});

      const sourcePoll = await request(app)
        .get('/poll')
        .query({ sid: 'studio-source' })
        .expect(200);

      const mismatchResponse = await request(app)
        .post('/response')
        .send({
          requestId: sourcePoll.body.requestId,
          sessionId: 'studio-target',
          response: { ok: false }
        })
        .expect(409);

      expect(mismatchResponse.body.error).toMatch(/session/i);

      const secondPoll = await request(app)
        .get('/poll')
        .query({ sid: 'studio-source' })
        .expect(200);
      expect(secondPoll.body.request).toBeNull();

      await request(app)
        .post('/response')
        .send({
          requestId: sourcePoll.body.requestId,
          sessionId: 'studio-source',
          response: { ok: true }
        })
        .expect(200);

      await expect(requestPromise).resolves.toEqual({ ok: true });
    });

    test('should not resurrect a disconnected session when a late response arrives', async () => {
      app.setMCPServerActive(true);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a' })
        .expect(200);

      const requestPromise = bridge.sendRequest('/api/source-only', { id: 1 }, { sessionId: 'studio-a' });
      requestPromise.catch(() => {});

      const poll = await request(app)
        .get('/poll')
        .query({ sid: 'studio-a' })
        .expect(200);

      await request(app)
        .post('/disconnect')
        .send({ sessionId: 'studio-a' })
        .expect(200);

      const lateResponse = await request(app)
        .post('/response')
        .send({
          requestId: poll.body.requestId,
          sessionId: 'studio-a',
          response: { ok: true }
        })
        .expect(409);

      expect(lateResponse.body.error).toMatch(/unknown request|not leased|session/i);
      expect(app.isPluginConnected()).toBe(false);

      const status = await request(app).get('/status').expect(200);
      const studioSession = status.body.sessions.find((session: any) => session.sessionId === 'studio-a');
      expect(studioSession?.ready).toBe(false);

      await expect(requestPromise).rejects.toThrow('Connection closed');
    });
  });

  describe('MCP Server State Management', () => {
    test('should track MCP server activity', async () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);

      app.trackMCPActivity();

      expect(app.isMCPServerActive()).toBe(true);
    });

    test('should timeout MCP server after inactivity', async () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);

      const originalDateNow = Date.now;
      Date.now = jest.fn(() => originalDateNow() + 16000);

      expect(app.isMCPServerActive()).toBe(false);

      Date.now = originalDateNow;
    });
  });

  describe('Status Endpoint', () => {
    test('should return current status', async () => {

      await request(app).post('/ready').send({ pluginInstanceId: 'test', sessionId: 'test' }).expect(200);
      app.setMCPServerActive(true);

      const response = await request(app)
        .get('/status')
        .expect(200);

      expect(response.body).toMatchObject({
        pluginConnected: true,
        mcpServerActive: true
      });
      expect(response.body.lastMCPActivity).toBeGreaterThan(0);
      expect(response.body.uptime).toBeGreaterThan(0);
      expect(response.body.bridge).toBeTruthy();
      expect(response.body.bridge.totalRequests).toBeGreaterThanOrEqual(0);
    });

    test('should include session place metadata in status payload', async () => {
      await request(app)
        .post('/ready')
        .send({
          pluginInstanceId: 'studio-a',
          sessionId: 'studio-a',
          placeId: 123456,
          placeName: 'Ready Place',
        })
        .expect(200);

      const response = await request(app)
        .get('/status')
        .expect(200);

      const studioSession = response.body.sessions.find((session: any) => session.sessionId === 'studio-a');
      expect(studioSession?.placeId).toBe(123456);
      expect(studioSession?.placeName).toBe('Ready Place');
    });

    test('should publish only implemented server capabilities in status payload', async () => {
      const response = await request(app)
        .get('/status')
        .expect(200);

      expect(response.body.serverCapabilities.setScriptSourceFast).toBe(false);
      expect(response.body.serverCapabilities.batchScriptEdits).toBe(false);
      expect(response.body.serverCapabilities.replaceScriptFunction).toBe(true);
    });
  });

  describe('Structure Map Endpoints', () => {
    test('should expose structure map summary endpoint', async () => {
      const getStructureMapSummarySpy = jest.spyOn(tools, 'getStructureMapSummary').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }]
      });

      const response = await request(app)
        .post('/mcp/get_structure_map_summary')
        .send({})
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(getStructureMapSummarySpy).toHaveBeenCalled();
    });

    test('should expose structure map query endpoint', async () => {
      const queryStructureMapSpy = jest.spyOn(tools, 'queryStructureMap').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }]
      });

      const response = await request(app)
        .post('/mcp/query_structure_map')
        .send({ filters: { pathPrefix: 'game.ServerScriptService' }, mode: 'compact' })
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(queryStructureMapSpy).toHaveBeenCalledWith(
        { pathPrefix: 'game.ServerScriptService' },
        'compact'
      );
    });

    test('should expose script inventory endpoint', async () => {
      const getScriptInventorySpy = jest.spyOn(tools, 'getScriptInventory').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }]
      });

      const response = await request(app)
        .post('/mcp/get_script_inventory')
        .send({ mode: 'compact' })
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(getScriptInventorySpy).toHaveBeenCalledWith('compact');
    });

    test('should expose cached script explanation endpoint', async () => {
      const explainScriptCachedSpy = jest.spyOn(tools, 'explainScriptCached').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }]
      });

      const response = await request(app)
        .post('/mcp/explain_script_cached')
        .send({ instancePath: 'game.ServerScriptService.Main' })
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(explainScriptCachedSpy).toHaveBeenCalledWith('game.ServerScriptService.Main');
    });

    test('should expose subsystem summary endpoint', async () => {
      const getSubsystemSummarySpy = jest.spyOn(tools, 'getSubsystemSummary').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }]
      });

      const response = await request(app)
        .post('/mcp/get_subsystem_summary')
        .send({ subsystem: 'AI' })
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(getSubsystemSummarySpy).toHaveBeenCalledWith('AI');
    });
  });

  describe('ROI Upgrade Endpoints', () => {
    test('should expose diagnostics, semantic edit, log stream, and perf snapshot endpoints', async () => {
      app.setMCPServerActive(true);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a' })
        .expect(200);

      const getLuauDiagnosticsSpy = jest.spyOn(tools as any, 'getLuauDiagnostics').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      });
      const replaceScriptFunctionSpy = jest.spyOn(tools as any, 'replaceScriptFunction').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      });
      const openDebugLogStreamSpy = jest.spyOn(tools as any, 'openDebugLogStream').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      });
      const pollDebugLogStreamSpy = jest.spyOn(tools as any, 'pollDebugLogStream').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      });
      const capturePerformanceSnapshotSpy = jest.spyOn(tools as any, 'capturePerformanceSnapshot').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      });

      await request(app)
        .post('/mcp/get_luau_diagnostics')
        .send({ instancePaths: ['game.ServerScriptService.Main'] })
        .expect(200);
      expect(getLuauDiagnosticsSpy).toHaveBeenCalledWith({
        instancePaths: ['game.ServerScriptService.Main'],
        includeSourceHints: undefined,
      });

      await request(app)
        .post('/mcp/replace_script_function')
        .send({
          instancePath: 'game.ServerScriptService.Main',
          functionName: 'M.foo',
          newFunctionContent: 'function M.foo() end',
        })
        .expect(200);
      expect(replaceScriptFunctionSpy).toHaveBeenCalledWith(
        'game.ServerScriptService.Main',
        'M.foo',
        'function M.foo() end',
        undefined,
      );

      await request(app)
        .post('/mcp/open_debug_log_stream')
        .send({ type: 'errors' })
        .expect(200);
      expect(openDebugLogStreamSpy).toHaveBeenCalledWith('errors');

      await request(app)
        .post('/mcp/poll_debug_log_stream')
        .send({ cursorId: 'cursor-1', maxLines: 25 })
        .expect(200);
      expect(pollDebugLogStreamSpy).toHaveBeenCalledWith('cursor-1', 25);

      await request(app)
        .post('/mcp/capture_performance_snapshot')
        .send({ category: 'all', sampleCount: 3, intervalMs: 10 })
        .expect(200);
      expect(capturePerformanceSnapshotSpy).toHaveBeenCalledWith('all', 3, 10);
    });
  });

  describe('Instance Snapshot Transfer Endpoints', () => {
    test('should expose export instance snapshot endpoint', async () => {
      const exportInstanceSnapshotSpy = jest.spyOn(tools, 'exportInstanceSnapshot').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ success: true, transferId: 'is_1' }) }]
      });

      const response = await request(app)
        .post('/mcp/export_instance_snapshot')
        .send({ instancePath: 'game.Workspace.Model', includeScripts: true, maxDepth: 20 })
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(exportInstanceSnapshotSpy).toHaveBeenCalledWith(
        'game.Workspace.Model',
        { includeScripts: true, maxDepth: 20 },
        undefined,
      );
    });

    test('should expose import instance snapshot endpoint', async () => {
      await request(app).post('/ready').send({ pluginInstanceId: 'test', sessionId: 'test' }).expect(200);
      app.setMCPServerActive(true);

      const importInstanceSnapshotSpy = jest.spyOn(tools, 'importInstanceSnapshot').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }]
      });

      const response = await request(app)
        .post('/mcp/import_instance_snapshot')
        .send({
          transferId: 'is_1',
          targetParentPath: 'game.Workspace',
          options: { conflictPolicy: 'rename' }
        })
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(importInstanceSnapshotSpy).toHaveBeenCalledWith(
        'is_1',
        'game.Workspace',
        { conflictPolicy: 'rename' },
        undefined,
      );
    });

    test('should expose list and delete snapshot transfer endpoints', async () => {
      const listInstanceSnapshotTransfersSpy = jest.spyOn(tools, 'listInstanceSnapshotTransfers').mockReturnValue({
        content: [{ type: 'text', text: JSON.stringify({ count: 1 }) }]
      });
      const deleteInstanceSnapshotTransferSpy = jest.spyOn(tools, 'deleteInstanceSnapshotTransfer').mockReturnValue({
        content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }]
      });

      const listResponse = await request(app)
        .post('/mcp/list_instance_snapshot_transfers')
        .send({})
        .expect(200);
      expect(listResponse.body.content?.[0]?.type).toBe('text');
      expect(listInstanceSnapshotTransfersSpy).toHaveBeenCalled();

      const deleteResponse = await request(app)
        .post('/mcp/delete_instance_snapshot_transfer')
        .send({ transferId: 'is_1' })
        .expect(200);
      expect(deleteResponse.body.content?.[0]?.type).toBe('text');
      expect(deleteInstanceSnapshotTransferSpy).toHaveBeenCalledWith('is_1');
    });

    test('should expose copy_instance_cross_session endpoint', async () => {
      await request(app).post('/ready').send({ pluginInstanceId: 'studio-target', sessionId: 'studio-target' }).expect(200);
      app.setMCPServerActive(true);
      const copyInstanceCrossSessionSpy = jest.spyOn(tools, 'copyInstanceCrossSession').mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }]
      });

      const response = await request(app)
        .post('/mcp/copy_instance_cross_session')
        .send({
          sourceSessionId: 'studio-source',
          targetSessionId: 'studio-target',
          sourceInstancePath: 'game.Workspace.Model',
          targetParentPath: 'game.Workspace',
          options: { conflictPolicy: 'rename' }
        })
        .expect(200);

      expect(response.body.content?.[0]?.type).toBe('text');
      expect(copyInstanceCrossSessionSpy).toHaveBeenCalledWith(
        'studio-source',
        'studio-target',
        'game.Workspace.Model',
        'game.Workspace',
        { conflictPolicy: 'rename' }
      );
    });
  });

  describe('Studio Session Endpoints', () => {
    test('should expose list_studio_sessions endpoint', async () => {
      app.setMCPServerActive(true);
      await request(app).post('/ready').send({
        pluginInstanceId: 'studio-a',
        sessionId: 'studio-a',
        version: '1.0.0',
        placeId: 54321,
        placeName: 'Session Endpoint Place',
      }).expect(200);

      const response = await request(app)
        .post('/mcp/list_studio_sessions')
        .send({})
        .expect(200);

      const payload = JSON.parse(response.body.content[0].text);
      const studioSession = payload.sessions.find((session: any) => session.sessionId === 'studio-a');
      expect(payload.count).toBeGreaterThanOrEqual(1);
      expect(studioSession).toBeTruthy();
      expect(studioSession.placeId).toBe(54321);
      expect(studioSession.placeName).toBe('Session Endpoint Place');
    });
  });

  describe('Write Routing Safety', () => {
    test('should reject unscoped writes when multiple studio sessions are ready', async () => {
      app.setMCPServerActive(true);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a', placeId: 1, placeName: 'Source Place' })
        .expect(200);
      await request(app)
        .post('/ready')
        .send({ pluginInstanceId: 'studio-b', sessionId: 'studio-b', placeId: 2, placeName: 'Target Place' })
        .expect(200);

      const response = await request(app)
        .post('/mcp/set_property')
        .send({
          instancePath: 'game.Workspace.Part',
          propertyName: 'Name',
          propertyValue: 'Renamed',
        })
        .expect(503);

      expect(response.body.error).toMatch(/sessionId/i);
    });
  });
});
