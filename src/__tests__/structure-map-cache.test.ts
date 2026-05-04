import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { summarizeScriptSource } from '../tools/script-summary';
import { StructureMapCache, mergeSummaryIntoSnapshot } from '../tools/structure-map-cache';
import type { PersistedStructureMapSnapshot } from '../tools/structure-map-cache';

describe('Structure map cache and script summaries', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'roblox-mcp-structure-cache-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('persists and reloads structure map data by place id', async () => {
    const cache = new StructureMapCache(tempDir);
    const placeId = 123456;
    const snapshot: PersistedStructureMapSnapshot = {
      placeId,
      placeName: 'Test Place',
      version: 1,
      updatedAt: 1,
      roots: ['game.ServerScriptService'],
      nodesByPath: {
        'game.ServerScriptService.Main': {
          path: 'game.ServerScriptService.Main',
          className: 'Script',
          hasSource: true,
          sourceHash: 'sha256:abc',
          summaryStatus: 'missing'
        }
      },
      scriptInventory: ['game.ServerScriptService.Main'],
      summaryIndex: {}
    };

    await cache.saveStructureMap(snapshot);
    const loaded = await cache.loadStructureMap(placeId);

    expect(loaded).toMatchObject(snapshot);
  });

  test('marks summaries stale when source hash changes', async () => {
    const snapshot: PersistedStructureMapSnapshot = {
      placeId: 1,
      placeName: 'Demo',
      version: 2,
      updatedAt: 1,
      roots: ['game.ServerScriptService'],
      nodesByPath: {
        'game.ServerScriptService.AI.EnemyBrain': {
          path: 'game.ServerScriptService.AI.EnemyBrain',
          className: 'ModuleScript',
          hasSource: true,
          sourceHash: 'sha256:new',
          summaryStatus: 'missing'
        }
      },
      summaryIndex: {
        'game.ServerScriptService.AI.EnemyBrain': {
          path: 'game.ServerScriptService.AI.EnemyBrain',
          sourceHash: 'sha256:old',
          summaryShort: 'Old summary',
          dependencies: [],
          servicesUsed: [],
          sideEffects: [],
          updatedAt: 1
        }
      },
      scriptInventory: ['game.ServerScriptService.AI.EnemyBrain']
    };

    const merged = mergeSummaryIntoSnapshot(snapshot);
    expect(merged.nodesByPath['game.ServerScriptService.AI.EnemyBrain'].summaryStatus).toBe('stale');
  });

  test('generates a deterministic compact summary from luau source', () => {
    const summary = summarizeScriptSource({
      instancePath: 'game.ServerScriptService.AI.EnemyBrain',
      source: [
        "local Players = game:GetService('Players')",
        "local ReplicatedStorage = game:GetService('ReplicatedStorage')",
        "local Util = require(script.Parent.Util)",
        '',
        'local EnemyBrain = {}',
        '',
        'function EnemyBrain.start()',
        "  print('start')",
        'end',
        '',
        'return EnemyBrain'
      ].join('\n')
    });

    expect(summary.summaryShort).toContain('EnemyBrain');
    expect(summary.dependencies).toContain('script.Parent.Util');
    expect(summary.servicesUsed).toEqual(expect.arrayContaining(['Players', 'ReplicatedStorage']));
  });

  test('persists and reloads full script source cache entries', async () => {
    const cache = new StructureMapCache(tempDir);
    const entry = {
      instancePath: 'game.ServerScriptService.Main',
      className: 'ModuleScript',
      name: 'Main',
      source: 'print("cached")\nreturn true\n',
      sourceHash: '4f9f2cab',
      sourceLength: 28,
      lineCount: 2,
      updatedAt: 123,
    };

    await (cache as any).saveScriptSource(entry);
    const loaded = await (cache as any).loadScriptSource(entry.instancePath);

    expect(loaded).toMatchObject(entry);
  });
});
