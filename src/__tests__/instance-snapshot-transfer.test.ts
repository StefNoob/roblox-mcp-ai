import { jest } from '@jest/globals';
import { BridgeService } from '../bridge-service';
import { RobloxStudioTools } from '../tools/index';
import { StudioHttpClient } from '../tools/studio-client.js';

describe('Instance Snapshot Transfers', () => {
  let tools: RobloxStudioTools;
  let studioRequest: jest.MockedFunction<StudioHttpClient['request']>;

  beforeEach(() => {
    tools = new RobloxStudioTools(new BridgeService());
    studioRequest = jest.fn<StudioHttpClient['request']>();
    (tools as any).client = {
      request: studioRequest,
    };
  });

  test('exports snapshot and stores transfer in memory', async () => {
    studioRequest.mockResolvedValue({
      success: true,
      snapshot: {
        version: 1,
        root: { className: 'Model', name: 'Tree', children: [] },
      },
      stats: {
        nodeCount: 1,
        serializedSizeBytes: 100,
      },
      warnings: [],
    });

    const exported = await tools.exportInstanceSnapshot('game.Workspace.Tree', { includeScripts: true, maxDepth: 12 });
    const payload = JSON.parse(exported.content[0].text);

    expect(payload.transferId).toMatch(/^is_/);
    expect(payload.sourceInstancePath).toBe('game.Workspace.Tree');
    expect(studioRequest).toHaveBeenCalledWith('/api/export-instance-snapshot', {
      instancePath: 'game.Workspace.Tree',
      includeScripts: true,
      maxDepth: 12,
    });

    const listed = tools.listInstanceSnapshotTransfers();
    const listedPayload = JSON.parse(listed.content[0].text);
    expect(listedPayload.count).toBe(1);
    expect(listedPayload.transfers[0].transferId).toBe(payload.transferId);
  });

  test('imports snapshot using transfer id', async () => {
    studioRequest
      .mockResolvedValueOnce({
        success: true,
        snapshot: {
          version: 1,
          root: { className: 'Model', name: 'Tree', children: [] },
        },
        stats: { nodeCount: 1 },
        warnings: [],
      })
      .mockResolvedValueOnce({
        success: true,
        rootInstancePath: 'game.Workspace.Tree_Copy1',
      });

    const exported = await tools.exportInstanceSnapshot('game.Workspace.Tree', {});
    const transferId = JSON.parse(exported.content[0].text).transferId as string;

    const imported = await tools.importInstanceSnapshot(transferId, 'game.Workspace', {
      conflictPolicy: 'rename',
      nameSuffix: '_v2',
    });
    const importPayload = JSON.parse(imported.content[0].text);

    expect(importPayload.transferId).toBe(transferId);
    expect(importPayload.result.success).toBe(true);
    expect(studioRequest).toHaveBeenLastCalledWith('/api/import-instance-snapshot', {
      targetParentPath: 'game.Workspace',
      snapshot: expect.any(Object),
      options: {
        conflictPolicy: 'rename',
        nameSuffix: '_v2',
      },
    });
  });

  test('copy_instance_snapshot composes export and import', async () => {
    studioRequest
      .mockResolvedValueOnce({
        success: true,
        snapshot: {
          version: 1,
          root: { className: 'Part', name: 'Door', children: [] },
        },
        stats: { nodeCount: 1 },
        warnings: [],
      })
      .mockResolvedValueOnce({
        success: true,
        rootInstancePath: 'game.Workspace.Door',
      });

    const copied = await tools.copyInstanceSnapshot('game.Workspace.Door', 'game.Workspace', {
      includeScripts: false,
      conflictPolicy: 'replace',
    });
    const payload = JSON.parse(copied.content[0].text);

    expect(payload.success).toBe(true);
    expect(payload.sourceInstancePath).toBe('game.Workspace.Door');
    expect(payload.targetParentPath).toBe('game.Workspace');
    expect(studioRequest).toHaveBeenNthCalledWith(1, '/api/export-instance-snapshot', {
      instancePath: 'game.Workspace.Door',
      includeScripts: false,
      maxDepth: undefined,
    });
    expect(studioRequest).toHaveBeenNthCalledWith(2, '/api/import-instance-snapshot', {
      targetParentPath: 'game.Workspace',
      snapshot: expect.any(Object),
      options: {
        rootName: undefined,
        conflictPolicy: 'replace',
        namePrefix: undefined,
        nameSuffix: undefined,
        scriptReplacements: undefined,
      },
    });
  });

  test('copy_instance_cross_session routes export/import by session', async () => {
    studioRequest
      .mockResolvedValueOnce({
        success: true,
        snapshot: {
          version: 1,
          root: { className: 'Model', name: 'Portal', children: [] },
        },
        stats: { nodeCount: 1 },
        warnings: [],
      })
      .mockResolvedValueOnce({
        success: true,
        rootInstancePath: 'game.Workspace.Portal',
      });

    const copied = await tools.copyInstanceCrossSession(
      'studio-source',
      'studio-target',
      'game.Workspace.Portal',
      'game.Workspace',
      { conflictPolicy: 'rename' },
    );
    const payload = JSON.parse(copied.content[0].text);
    expect(payload.mode).toBe('cross-session');
    expect(payload.sourceSessionId).toBe('studio-source');
    expect(payload.targetSessionId).toBe('studio-target');
    expect(studioRequest).toHaveBeenNthCalledWith(1, '/api/export-instance-snapshot', {
      instancePath: 'game.Workspace.Portal',
      includeScripts: true,
      maxDepth: undefined,
    }, { sessionId: 'studio-source' });
    expect(studioRequest).toHaveBeenNthCalledWith(2, '/api/import-instance-snapshot', {
      targetParentPath: 'game.Workspace',
      snapshot: expect.any(Object),
      options: {
        rootName: undefined,
        conflictPolicy: 'rename',
        namePrefix: undefined,
        nameSuffix: undefined,
        scriptReplacements: undefined,
      },
    }, { sessionId: 'studio-target' });
  });
});
