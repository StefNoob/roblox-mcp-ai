import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { PersistedStructureMapSnapshot } from '../tools/structure-map-cache.js';
import {
  analyzeArchitectureSnapshot,
  analyzeScriptQuality,
} from '../tools/analysis-tools.js';

function createSnapshot(): PersistedStructureMapSnapshot {
  return {
    placeId: 777,
    placeName: 'Quality Test Place',
    version: 1,
    updatedAt: 1,
    roots: ['game.ServerScriptService', 'game.StarterPlayer.StarterPlayerScripts'],
    nodesByPath: {
      'game.ServerScriptService.Combat.Brain': {
        path: 'game.ServerScriptService.Combat.Brain',
        name: 'Brain',
        className: 'ModuleScript',
        hasSource: true,
        scriptType: 'ModuleScript',
        sourceHash: 'sha256:brain',
        subsystem: 'Combat',
      },
      'game.ServerScriptService.Combat.Controller': {
        path: 'game.ServerScriptService.Combat.Controller',
        name: 'Controller',
        className: 'Script',
        hasSource: true,
        scriptType: 'Script',
        sourceHash: 'sha256:controller',
        subsystem: 'Combat',
      },
      'game.StarterPlayer.StarterPlayerScripts.HUD': {
        path: 'game.StarterPlayer.StarterPlayerScripts.HUD',
        name: 'HUD',
        className: 'LocalScript',
        hasSource: true,
        scriptType: 'LocalScript',
        sourceHash: 'sha256:hud',
        subsystem: 'UI',
      },
    },
    scriptInventory: [
      'game.ServerScriptService.Combat.Brain',
      'game.ServerScriptService.Combat.Controller',
      'game.StarterPlayer.StarterPlayerScripts.HUD',
    ],
    summaryIndex: {
      'game.ServerScriptService.Combat.Brain': {
        path: 'game.ServerScriptService.Combat.Brain',
        sourceHash: 'sha256:brain',
        summaryShort: 'Brain script',
        summaryLong: 'Combat brain summary',
        purpose: 'Combat AI behavior',
        exports: ['Brain.start', 'Brain.stop'],
        dependencies: ['script.Parent.Util', 'game.ReplicatedStorage.Shared.Config'],
        servicesUsed: ['Players', 'RunService', 'ReplicatedStorage'],
        sideEffects: ['task-spawn'],
        subsystem: 'Combat',
        updatedAt: 1,
      },
      'game.ServerScriptService.Combat.Controller': {
        path: 'game.ServerScriptService.Combat.Controller',
        sourceHash: 'sha256:controller',
        summaryShort: 'Controller script',
        summaryLong: 'Combat controller summary',
        purpose: 'Combat startup',
        exports: ['bootstrap'],
        dependencies: ['script.Parent.Brain'],
        servicesUsed: ['Players'],
        sideEffects: ['remote-server-listener'],
        subsystem: 'Combat',
        updatedAt: 1,
      },
      'game.StarterPlayer.StarterPlayerScripts.HUD': {
        path: 'game.StarterPlayer.StarterPlayerScripts.HUD',
        sourceHash: 'sha256:hud',
        summaryShort: 'HUD script',
        summaryLong: 'UI hud summary',
        purpose: 'HUD updates',
        exports: ['render'],
        dependencies: [],
        servicesUsed: ['TweenService'],
        sideEffects: ['remote-client-listener'],
        subsystem: 'UI',
        updatedAt: 1,
      },
    },
  };
}

describe('AI-first architecture and quality tools', () => {
  test('analyzeArchitectureSnapshot summarizes subsystems and hotspots', () => {
    const report = analyzeArchitectureSnapshot(createSnapshot(), {
      includeDependencies: true,
      limit: 10,
    });

    expect(report.summary.scriptCount).toBe(3);
    expect(report.subsystems[0]).toMatchObject({
      subsystem: 'Combat',
      scriptCount: 2,
    });
    expect(report.hotspots[0].path).toBe('game.ServerScriptService.Combat.Brain');
    expect(report.entrypoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'game.ServerScriptService.Combat.Controller' }),
        expect.objectContaining({ path: 'game.StarterPlayer.StarterPlayerScripts.HUD' }),
      ]),
    );
    expect(report.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'coupling' }),
      ]),
    );
  });

  test('analyzeScriptQuality flags risky Luau patterns and missing strict mode', () => {
    const report = analyzeScriptQuality({
      path: 'game.ServerScriptService.Combat.LegacyService',
      className: 'Script',
      scriptType: 'Script',
      subsystem: 'Combat',
      summaryShort: 'Legacy service',
      source: [
        "local PhysicsService = game:GetService('PhysicsService')",
        "local Players = game:GetService('Players')",
        'local Legacy = {}',
        '',
        'function Legacy.start()',
        '  wait(1)',
        '  spawn(function() end)',
        '  while true do',
        '    task.wait(1)',
        '  end',
        'end',
        '',
        'local groups = PhysicsService:GetCollisionGroups()',
        '',
        'return Legacy',
      ].join('\n'),
      dependencies: ['script.Parent.Util', 'script.Parent.State'],
      servicesUsed: ['PhysicsService', 'Players'],
      sideEffects: ['infinite-loop'],
    });

    expect(report.score).toBeLessThan(80);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'strict-mode', severity: 'medium' }),
        expect.objectContaining({ category: 'legacy-wait', severity: 'medium' }),
        expect.objectContaining({ category: 'deprecated-api', severity: 'high' }),
        expect.objectContaining({ category: 'infinite-loop', severity: 'high' }),
      ]),
    );
  });

  test('RobloxStudioTools exposes architecture and quality reports through MCP-style payloads', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const snapshot = createSnapshot();
    const sourceByPath: Record<string, string> = {
      'game.ServerScriptService.Combat.Brain': [
        '--!strict',
        "local Players = game:GetService('Players')",
        "local Config = require(game.ReplicatedStorage.Shared.Config)",
        'local Brain = {}',
        'function Brain.start()',
        '  task.spawn(function() end)',
        'end',
        'return Brain',
      ].join('\n'),
      'game.ServerScriptService.Combat.Controller': [
        "local Brain = require(script.Parent.Brain)",
        'game.ReplicatedStorage.Remotes.Attack.OnServerEvent:Connect(function() end)',
        'Brain.start()',
      ].join('\n'),
    };

    (tools as any).ensureStructureMapSnapshot = jest.fn().mockResolvedValue(snapshot);
    (tools as any).readFullScriptSource = jest.fn(async (instancePath: string) => ({
      source: sourceByPath[instancePath] || '--!strict\nreturn {}',
    }));

    const architectureRaw = await tools.analyzeProjectArchitecture({ subsystem: 'Combat', includeDependencies: true });
    const architecture = JSON.parse(architectureRaw.content[0].text);
    expect(architecture.summary.scriptCount).toBe(2);
    expect(architecture.filters.subsystem).toBe('Combat');

    const qualityRaw = await tools.analyzeCodeQuality({ instancePaths: ['game.ServerScriptService.Combat.Controller'] });
    const quality = JSON.parse(qualityRaw.content[0].text);
    expect(quality.summary.scriptCount).toBe(1);
    expect(quality.scripts[0].path).toBe('game.ServerScriptService.Combat.Controller');
    expect(quality.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scriptPath: 'game.ServerScriptService.Combat.Controller' }),
      ]),
    );
  });
});
