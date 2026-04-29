import { readFile } from 'fs/promises';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

describe('P0 token optimization contracts', () => {
  test('getInstanceProperties omits script source unless explicitly requested', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const studioRequest = jest.fn().mockResolvedValue({ ok: true });
    (tools as any).client = { request: studioRequest };

    await tools.getInstanceProperties('game.ServerScriptService.Main');
    await (tools as any).getInstanceProperties('game.ServerScriptService.Main', true);

    expect(studioRequest).toHaveBeenNthCalledWith(1, '/api/instance-properties', {
      instancePath: 'game.ServerScriptService.Main',
      includeSource: false,
    });
    expect(studioRequest).toHaveBeenNthCalledWith(2, '/api/instance-properties', {
      instancePath: 'game.ServerScriptService.Main',
      includeSource: true,
    });
  });

  test('tool metadata and docs prefer map-first bootstrap', async () => {
    const [indexSource, readme, agentDoc, clientsDoc] = await Promise.all([
      readFile('src/index.ts', 'utf8'),
      readFile('README.md', 'utf8'),
      readFile('AGENT.md', 'utf8'),
      readFile('docs/CLIENTS.md', 'utf8'),
    ]);

    expect(indexSource).toContain("includeSource");
    expect(indexSource).not.toContain('Set higher values like 5-10 for comprehensive exploration');
    expect(readme).toContain('AGENT_LITE.md');
    expect(agentDoc).toContain('get_structure_map_summary');
    expect(agentDoc).toContain('query_structure_map');
    expect(clientsDoc).toContain('map-first');
  });
});
