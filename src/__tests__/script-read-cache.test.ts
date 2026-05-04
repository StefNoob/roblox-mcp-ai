import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StructureMapCache, fnv1a32 } from '../tools/structure-map-cache.js';
import { StudioHttpClient } from '../tools/studio-client.js';

describe('script read caching and chunking', () => {
  let tempDir: string;
  let tools: RobloxStudioTools;
  let studioRequest: jest.MockedFunction<StudioHttpClient['request']>;
  let cache: StructureMapCache;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'roblox-mcp-script-cache-'));
    tools = new RobloxStudioTools(new BridgeService());
    studioRequest = jest.fn<StudioHttpClient['request']>();
    cache = new StructureMapCache(tempDir);
    (tools as any).client = { request: studioRequest };
    (tools as any).structureMapCache = cache;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('reuses cached script source when metadata matches', async () => {
    const instancePath = 'game.ServerScriptService.Main';
    const source = 'print("cached")\nreturn true\n';

    await (cache as any).saveScriptSource({
      instancePath,
      className: 'ModuleScript',
      name: 'Main',
      source,
      sourceHash: fnv1a32(source),
      sourceLength: source.length,
      lineCount: 2,
      updatedAt: 1,
    });

    studioRequest.mockImplementation(async (endpoint) => {
      if (endpoint === '/api/get-script-metadata') {
        return {
          instancePath,
          className: 'ModuleScript',
          name: 'Main',
          sourceLength: source.length,
          lineCount: 2,
          sourceHash: fnv1a32(source),
        };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const response = await (tools as any).readFullScriptSource(instancePath);

    expect(response).toMatchObject({
      instancePath,
      className: 'ModuleScript',
      name: 'Main',
      source,
      sourceLength: source.length,
      lineCount: 2,
      startLine: 1,
      endLine: 2,
      truncated: false,
    });
    expect(studioRequest).toHaveBeenCalledTimes(1);
  });

  test('refreshes the disk cache when metadata changes', async () => {
    const instancePath = 'game.ServerScriptService.Main';
    const oldSource = 'print("old")\n';
    const newSource = 'print("new")\nreturn 1\n';

    await (cache as any).saveScriptSource({
      instancePath,
      className: 'ModuleScript',
      name: 'Main',
      source: oldSource,
      sourceHash: fnv1a32(oldSource),
      sourceLength: oldSource.length,
      lineCount: 1,
      updatedAt: 1,
    });

    studioRequest.mockImplementation(async (endpoint, payload: any) => {
      if (endpoint === '/api/get-script-metadata') {
        return {
          instancePath,
          className: 'ModuleScript',
          name: 'Main',
          sourceLength: newSource.length,
          lineCount: 2,
          sourceHash: fnv1a32(newSource),
        };
      }

      if (endpoint === '/api/get-script-source') {
        expect(payload).toMatchObject({
          instancePath,
          fullSource: true,
          includeNumberedSource: false,
        });
        return {
          instancePath,
          className: 'ModuleScript',
          name: 'Main',
          source: newSource,
          sourceLength: newSource.length,
          lineCount: 2,
          startLine: 1,
          endLine: 2,
          truncated: false,
        };
      }

      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const response = await (tools as any).readFullScriptSource(instancePath);
    const cached = await (cache as any).loadScriptSource(instancePath);

    expect(response.source).toBe(newSource);
    expect(cached).toMatchObject({
      instancePath,
      source: newSource,
      sourceHash: fnv1a32(newSource),
      sourceLength: newSource.length,
      lineCount: 2,
    });
  });

  test('fetches large script chunks in parallel and reconstructs them in order', async () => {
    const instancePath = 'game.ServerScriptService.Chunked';
    const lines = Array.from({ length: 1205 }, (_, index) => `line_${index + 1}`);
    const fullSource = lines.join('\n');
    const firstChunk = lines.slice(0, 1000).join('\n');
    const secondChunk = lines.slice(1000).join('\n');
    let firstChunkResolved = false;
    let secondChunkRequestedBeforeFirstResolved = false;
    let resolveFirstChunk: ((value: unknown) => void) | undefined;
    let resolveSecondChunk: ((value: unknown) => void) | undefined;

    studioRequest.mockImplementation(async (endpoint, payload: any) => {
      if (endpoint === '/api/get-script-metadata') {
        return {
          instancePath,
          className: 'Script',
          name: 'Chunked',
          sourceLength: fullSource.length,
          lineCount: lines.length,
          sourceHash: fnv1a32(fullSource),
        };
      }

      if (endpoint !== '/api/get-script-source') {
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }

      expect(payload.includeNumberedSource).toBe(false);

      if (payload.startLine === 1 && payload.endLine === 1000) {
        return new Promise((resolve) => {
          resolveFirstChunk = (value) => {
            firstChunkResolved = true;
            resolve(value);
          };
        });
      }

      if (payload.startLine === 1001 && payload.endLine === 1205) {
        secondChunkRequestedBeforeFirstResolved = !firstChunkResolved;
        return new Promise((resolve) => {
          resolveSecondChunk = resolve;
        });
      }

      throw new Error(`Unexpected payload: ${JSON.stringify(payload)}`);
    });

    const pending = (tools as any).readFullScriptSource(instancePath);
    for (let attempt = 0; attempt < 10 && (!resolveFirstChunk || !resolveSecondChunk); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(resolveFirstChunk).toBeDefined();
    expect(resolveSecondChunk).toBeDefined();
    expect(secondChunkRequestedBeforeFirstResolved).toBe(true);

    resolveSecondChunk?.({
      instancePath,
      className: 'Script',
      name: 'Chunked',
      source: secondChunk,
      sourceLength: fullSource.length,
      lineCount: lines.length,
      startLine: 1001,
      endLine: 1205,
      truncated: false,
    });
    resolveFirstChunk?.({
      instancePath,
      className: 'Script',
      name: 'Chunked',
      source: firstChunk,
      sourceLength: fullSource.length,
      lineCount: lines.length,
      startLine: 1,
      endLine: 1000,
      truncated: false,
    });

    const response = await pending;

    expect(response).toMatchObject({
      source: fullSource,
      lineCount: lines.length,
      startLine: 1,
      endLine: lines.length,
      truncated: false,
      reconstructedFromChunks: true,
    });
  });
});
