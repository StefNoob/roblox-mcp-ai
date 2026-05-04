import { jest } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { StudioHttpClient } from '../tools/studio-client.js';

describe('StudioHttpClient', () => {
  test('surfaces actionable timeout troubleshooting steps', async () => {
    const bridge = new BridgeService();
    const client = new StudioHttpClient(bridge);
    jest.spyOn(bridge, 'sendRequest').mockRejectedValue(new Error('Request timeout'));

    await expect(client.request('/api/test', {})).rejects.toThrow(
      'Game Settings -> Security -> Enable "Allow HTTP Requests".',
    );
    await expect(client.request('/api/test', {})).rejects.toThrow(
      'click "MCP Server" button, then click "Connect".',
    );
  });
});
