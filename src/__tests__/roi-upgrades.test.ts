import { jest } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

describe('ROI MCP upgrades', () => {
  let tools: RobloxStudioTools;
  let studioRequest: jest.MockedFunction<StudioHttpClient['request']>;

  beforeEach(() => {
    tools = new RobloxStudioTools(new BridgeService());
    studioRequest = jest.fn<StudioHttpClient['request']>();
    (tools as any).client = {
      request: studioRequest,
    };
  });

  test('getLuauDiagnostics maps analyzer output back to Studio instance paths', async () => {
    jest.spyOn(tools as any, 'readFullScriptSource').mockImplementation(async (...args: unknown[]) => ({
      source: `--!strict\n-- ${String(args[0])}\nreturn nil\n`,
    }));
    jest.spyOn(tools as any, 'runLuauDiagnosticsCommand').mockImplementation(async (...args: unknown[]) => {
      const filePaths = args[0] as string[];
      return ({
      code: 1,
      stdout: [
        `${filePaths[0]}(3,5): TypeError: Type 'nil' could not be converted into 'number'`,
        `${filePaths[1]}(1,1): Warning: Unused local 'temp'`,
      ].join('\n'),
      stderr: '',
      binary: 'luau-lsp',
      });
    });

    const response = await (tools as any).getLuauDiagnostics({
      instancePaths: [
        'game.ServerScriptService.Main',
        'game.ReplicatedStorage.Shared.Util',
      ],
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.tooling.available).toBe(true);
    expect(payload.summary.totalFindings).toBe(2);
    expect(payload.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: 'game.ServerScriptService.Main',
          line: 3,
          column: 5,
          severity: 'error',
        }),
        expect.objectContaining({
          instancePath: 'game.ReplicatedStorage.Shared.Util',
          line: 1,
          column: 1,
          severity: 'warning',
        }),
      ]),
    );
  });

  test('replaceScriptFunction rewrites one Luau function body without line math', async () => {
    studioRequest.mockImplementation(async (endpoint: string, payload?: any) => {
      if (endpoint === '/api/get-script-source') {
        return {
          source: [
            'local M = {}',
            '',
            'function M.foo(x)',
            '  local y = x + 1',
            '  return y',
            'end',
            '',
            'function M.bar()',
            '  return 1',
            'end',
            '',
            'return M',
            '',
          ].join('\n'),
          lineCount: 12,
          startLine: 1,
          endLine: 12,
          truncated: false,
        };
      }
      if (endpoint === '/api/set-script-source') {
        return {
          success: true,
          source: payload?.source,
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const response = await (tools as any).replaceScriptFunction(
      'game.ServerScriptService.Main',
      'M.foo',
      [
        'function M.foo(x)',
        '  return x * 2',
        'end',
      ].join('\n'),
    );
    const payload = JSON.parse(response.content[0].text);

    expect(payload.success).toBe(true);
    expect(payload.functionName).toBe('M.foo');
    expect(studioRequest).toHaveBeenCalledWith('/api/set-script-source', {
      instancePath: 'game.ServerScriptService.Main',
      source: [
        'local M = {}',
        '',
        'function M.foo(x)',
        '  return x * 2',
        'end',
        '',
        'function M.bar()',
        '  return 1',
        'end',
        '',
        'return M',
        '',
      ].join('\n'),
      preferDirect: false,
    });
  });

  test('debug log stream cursor uses incremental polling and filters duplicates', async () => {
    studioRequest
      .mockResolvedValueOnce({
        type: 'errors',
        count: 1,
        logs: [
          {
            message: 'boom',
            messageType: 'Message',
            timestamp: 10,
          },
        ],
      })
      .mockResolvedValueOnce({
        type: 'errors',
        count: 2,
        logs: [
          {
            message: 'boom',
            messageType: 'Message',
            timestamp: 10,
          },
          {
            message: 'new warning',
            messageType: 'Warning',
            timestamp: 12,
          },
        ],
      });

    const opened = JSON.parse((await (tools as any).openDebugLogStream('errors')).content[0].text);
    const first = JSON.parse((await (tools as any).pollDebugLogStream(opened.cursorId, 50)).content[0].text);
    const second = JSON.parse((await (tools as any).pollDebugLogStream(opened.cursorId, 50)).content[0].text);

    expect(first.logs).toHaveLength(1);
    expect(second.logs).toHaveLength(1);
    expect(second.logs[0]).toMatchObject({ message: 'new warning', timestamp: 12 });
    expect(studioRequest.mock.calls[1][1]).toMatchObject({
      type: 'errors',
      sinceTimestamp: 10,
      maxLines: 50,
    });
  });

  test('capturePerformanceSnapshot aggregates repeated samples', async () => {
    studioRequest
      .mockResolvedValueOnce({
        fps: { current: 60 },
        memory: { physical: 100 },
      })
      .mockResolvedValueOnce({
        fps: { current: 55 },
        memory: { physical: 120 },
      });

    jest.spyOn(tools as any, 'sleep').mockResolvedValue(undefined);

    const response = await (tools as any).capturePerformanceSnapshot('all', 2, 15);
    const payload = JSON.parse(response.content[0].text);

    expect(payload.samples).toHaveLength(2);
    expect(payload.summary['fps.current']).toEqual({
      min: 55,
      max: 60,
      avg: 57.5,
      latest: 55,
    });
    expect(payload.summary['memory.physical']).toEqual({
      min: 100,
      max: 120,
      avg: 110,
      latest: 120,
    });
  });
});
