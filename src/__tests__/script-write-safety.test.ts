import { jest } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

describe('script write safety', () => {
  let tools: RobloxStudioTools;
  let studioRequest: jest.MockedFunction<StudioHttpClient['request']>;

  beforeEach(() => {
    tools = new RobloxStudioTools(new BridgeService());
    studioRequest = jest.fn<StudioHttpClient['request']>();
    (tools as any).client = {
      request: studioRequest,
    };
  });

  test('rejects set_property on Source', async () => {
    await expect(
      tools.setProperty('game.ServerScriptService.Main', 'Source', 'print("bad")'),
    ).rejects.toThrow('set_property cannot be used for the Source property');
  });

  test('commits chunked uploads through set-script-source bridge', async () => {
    studioRequest.mockResolvedValue({
      success: true,
      method: 'UpdateSourceAsync',
    });

    const begin = JSON.parse((await tools.beginScriptSourceUpload('game.ServerScriptService.Main')).content[0].text);
    await tools.appendScriptSourceUploadChunk(begin.uploadId, 'print("hello")\n', 0);
    await tools.appendScriptSourceUploadChunk(begin.uploadId, 'return 1', 1);
    await tools.commitScriptSourceUpload(begin.uploadId);

    expect(studioRequest).toHaveBeenCalledWith('/api/set-script-source', {
      instancePath: 'game.ServerScriptService.Main',
      source: 'print("hello")\nreturn 1',
      preferDirect: false,
    });
  });

  test('fast write fallback uses set-script-source bridge instead of set-property', async () => {
    studioRequest.mockImplementation(async (endpoint) => {
      if (endpoint === '/api/set-script-source-fast') {
        throw new Error('Unknown endpoint: /api/set-script-source-fast');
      }
      if (endpoint === '/api/set-script-source') {
        return {
          success: true,
          method: 'UpdateSourceAsync',
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const response = await tools.setScriptSourceFast('game.ServerScriptService.Main', 'print("safe")', false);
    const payload = JSON.parse(response.content[0].text);

    expect(payload.method).toBe('fast-fallback-bridge');
    expect(studioRequest).not.toHaveBeenCalledWith(
      '/api/set-property',
      expect.anything(),
    );
  });

  test('batch script edits fallback applies operations locally when plugin lacks endpoint', async () => {
    studioRequest.mockImplementation(async (endpoint: string, payload?: any) => {
      if (endpoint === '/api/get-script-source') {
        return {
          source: 'local a = 1\nprint(local a)\n',
          lineCount: 2,
          startLine: 1,
          endLine: 2,
          truncated: false,
        };
      }
      if (endpoint === '/api/batch-script-edits') {
        throw new Error('Unknown endpoint: /api/batch-script-edits');
      }
      if (endpoint === '/api/set-script-source') {
        return {
          success: true,
          method: 'UpdateSourceAsync',
          source: payload?.source,
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const response = await tools.batchScriptEdits(
      'game.ServerScriptService.Main',
      [
        { op: 'replace', startLine: 1, endLine: 1, newContent: 'local a = 2' },
        { op: 'insert', afterLine: 2, newContent: 'return a' },
      ],
    );

    const result = JSON.parse(response.content[0].text);

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(true);
    expect(studioRequest).toHaveBeenCalledWith('/api/set-script-source', {
      instancePath: 'game.ServerScriptService.Main',
      source: 'local a = 2\nprint(local a)\nreturn a\n',
      preferDirect: false,
    });
  });
});
