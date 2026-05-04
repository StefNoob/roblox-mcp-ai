import { jest } from '@jest/globals';
import request from 'supertest';
import { createHttpServer } from '../http-server';
import { RobloxStudioTools } from '../tools/index';
import { BridgeService } from '../bridge-service';
import { Application } from 'express';

const READY_PAYLOAD = {
  pluginInstanceId: 'studio-a',
  sessionId: 'studio-a',
};

describe('Integration Tests', () => {
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

  describe('Full Connection Flow', () => {
    test('should handle complete connection lifecycle', async () => {

      let status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
      expect(status.body.mcpServerActive).toBe(false);

      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);

      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(true);
      expect(status.body.mcpServerActive).toBe(false);

      let pollResponse = await request(app).get('/poll').expect(503);
      expect(pollResponse.body).toMatchObject({
        error: 'MCP server not connected',
        pluginConnected: true,
        mcpConnected: false
      });

      app.setMCPServerActive(true);

      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(true);
      expect(status.body.mcpServerActive).toBe(true);

      pollResponse = await request(app).get('/poll').expect(200);
      expect(pollResponse.body).toMatchObject({
        request: null,
        mcpConnected: true,
        pluginConnected: true
      });

      await request(app).post('/disconnect').send({ sessionId: 'studio-a' }).expect(200);

      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
      expect(status.body.mcpServerActive).toBe(true);
    });
  });

  describe('Request/Response Flow', () => {
    test('should handle complete request/response cycle', async () => {

      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);
      app.setMCPServerActive(true);

      const mcpRequestPromise = bridge.sendRequest('/api/test-endpoint', {
        testData: 'hello',
        value: 123
      });

      const pollResponse = await request(app).get('/poll').expect(200);
      expect(pollResponse.body.request).toMatchObject({
        endpoint: '/api/test-endpoint',
        data: {
          testData: 'hello',
          value: 123
        }
      });
      const requestId = pollResponse.body.requestId;

      await request(app)
        .post('/response')
        .send({
          requestId: requestId,
          response: {
            success: true,
            result: 'processed',
            echo: 'hello'
          }
        })
        .expect(200);

      const mcpResponse = await mcpRequestPromise;
      expect(mcpResponse).toEqual({
        success: true,
        result: 'processed',
        echo: 'hello'
      });
    });

    test('should handle error responses', async () => {

      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);
      app.setMCPServerActive(true);

      const mcpRequestPromise = bridge.sendRequest('/api/failing-endpoint', {});
      mcpRequestPromise.catch(() => {});

      const pollResponse = await request(app).get('/poll').expect(200);
      const requestId = pollResponse.body.requestId;

      await request(app)
        .post('/response')
        .send({
          requestId: requestId,
          error: 'Operation failed: Invalid input'
        })
        .expect(200);

      await expect(mcpRequestPromise).rejects.toEqual('Operation failed: Invalid input');
    });
  });

  describe('Disconnect Recovery', () => {
    test('should handle disconnect and reconnect gracefully', async () => {

      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);
      app.setMCPServerActive(true);

      const request1 = bridge.sendRequest('/api/test1', {}, { sessionId: 'studio-a' });
      const request2 = bridge.sendRequest('/api/test2', {}, { sessionId: 'studio-a' });
      request1.catch(() => {});
      request2.catch(() => {});

      let poll = await request(app).get('/poll?sessionId=studio-a').expect(200);
      expect(poll.body.request).toBeTruthy();

      await request(app).post('/disconnect').send({ sessionId: 'studio-a' }).expect(200);

      await expect(request1).rejects.toThrow('Connection closed');
      await expect(request2).rejects.toThrow('Connection closed');

      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);

      const newRequestPromise = bridge.sendRequest('/api/test3', {});

      poll = await request(app).get('/poll?sessionId=studio-a').expect(200);
      expect(poll.body.request?.endpoint).toBe('/api/test3');

      await request(app)
        .post('/response')
        .send({
          sessionId: 'studio-a',
          requestId: poll.body.requestId,
          response: { success: true }
        })
        .expect(200);

      const result = await newRequestPromise;
      expect(result).toEqual({ success: true });
    });
  });

  describe('Connection State Display', () => {
    test('should show correct pending states during connection', async () => {

      let health = await request(app).get('/health').expect(200);
      expect(health.body.pluginConnected).toBe(false);
      expect(health.body.mcpServerActive).toBe(false);

      await request(app).get('/poll').expect(503);

      health = await request(app).get('/health').expect(200);
      expect(health.body.pluginConnected).toBe(false);
      expect(health.body.mcpServerActive).toBe(false);
      expect(health.body.plugin.polling).toBe(true);
      expect(health.body.plugin.ready).toBe(false);

      app.setMCPServerActive(true);

      const poll = await request(app).get('/poll').expect(200);
      expect(poll.body.mcpConnected).toBe(true);
      expect(poll.body.pluginConnected).toBe(false);
      expect(poll.body.plugin.polling).toBe(true);
      expect(poll.body.plugin.ready).toBe(false);
    });
  });

  describe('Timeout Handling', () => {
    test('should handle request timeouts', async () => {
      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);
      app.setMCPServerActive(true);

      jest.useFakeTimers();
      const timeoutPromise = bridge.sendRequest('/api/slow-endpoint', {});
      const expectPromise = expect(timeoutPromise).rejects.toThrow('Request timeout');

      await jest.advanceTimersByTimeAsync(31000);

      await expectPromise;

      jest.useRealTimers();
    });
  });

  describe('Structure Map Diagnostics Flow', () => {
    test('should surface structure map cache fields in diagnostics after MCP activation', async () => {
      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);
      app.setMCPServerActive(true);

      const diagnostics = await request(app)
        .post('/mcp/get_diagnostics')
        .send({})
        .expect(200);

      const payload = JSON.parse(diagnostics.body.content[0].text);
      expect(payload.runtime.structureMap).toBeTruthy();
      expect(payload.runtime.structureMap.cache).toBeTruthy();
      expect(payload.runtime.structureMap.summaries).toBeTruthy();
    });

    test('should keep diagnostics capability flags aligned with implemented plugin endpoints', async () => {
      await request(app).post('/ready').send(READY_PAYLOAD).expect(200);
      app.setMCPServerActive(true);

      const diagnostics = await request(app).get('/diagnostics').expect(200);

      expect(diagnostics.body.serverCapabilities.setScriptSourceFast).toBe(false);
      expect(diagnostics.body.serverCapabilities.batchScriptEdits).toBe(false);
      expect(diagnostics.body.serverCapabilities.replaceScriptFunction).toBe(true);
    });
  });
});
