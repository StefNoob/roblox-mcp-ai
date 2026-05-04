import { jest } from '@jest/globals';
import request from 'supertest';
import { Application } from 'express';
import { createHttpServer } from '../http-server';
import { RobloxStudioTools } from '../tools/index';
import { BridgeService } from '../bridge-service';

describe('HTTP Server Parsing', () => {
  let app: Application & any;
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new BridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  test('rejects non-object ready payloads without marking plugin connected', async () => {
    const response = await request(app)
      .post('/ready')
      .set('Content-Type', 'text/plain')
      .send('oops')
      .expect(400);

    expect(response.body.error).toMatch(/invalid json|json body|invalid ready payload/i);
    expect(app.isPluginConnected()).toBe(false);

    const status = await request(app).get('/status').expect(200);
    expect(status.body.pluginConnected).toBe(false);
    expect(status.body.sessions).toEqual([]);
  });

  test('rejects ready payloads missing sessionId', async () => {
    const response = await request(app)
      .post('/ready')
      .send({})
      .expect(400);

    expect(response.body.error).toMatch(/sessionid|required|invalid ready payload/i);
    expect(app.isPluginConnected()).toBe(false);
  });

  test('rejects response payloads missing requestId with a parsing error', async () => {
    const response = await request(app)
      .post('/response')
      .send({ response: { ok: true } })
      .expect(400);

    expect(response.body.error).toMatch(/requestid|required|invalid response payload/i);
  });

  test('routes wrapped MCP arguments through session-aware write parsing', async () => {
    app.setMCPServerActive(true);

    await request(app)
      .post('/ready')
      .send({ pluginInstanceId: 'studio-a', sessionId: 'studio-a', ready: true })
      .expect(200);
    await request(app)
      .post('/ready')
      .send({ pluginInstanceId: 'studio-b', sessionId: 'studio-b', ready: true })
      .expect(200);

    const setPropertySpy = jest.spyOn(tools, 'setProperty').mockImplementation(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
    }));

    const response = await request(app)
      .post('/mcp/set_property')
      .send({
        arguments: {
          sessionId: 'studio-a',
          instancePath: 'game.Workspace.Part',
          propertyName: 'Name',
          propertyValue: 'RenamedPart',
        },
      })
      .expect(200);

    expect(response.body.content?.[0]?.type).toBe('text');
    expect(setPropertySpy).toHaveBeenCalledWith('game.Workspace.Part', 'Name', 'RenamedPart');
  });
});
