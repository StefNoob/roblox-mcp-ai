import { BridgeService } from '../bridge-service.js';

export class StudioHttpClient {
  private bridge: BridgeService;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
  }

  async request(endpoint: string, data: any, options?: { sessionId?: string }): Promise<any> {
    try {
      const response = await this.bridge.sendRequest(endpoint, data, options);
      if (response && typeof response === 'object' && typeof response.error === 'string') {
        throw new Error(`Studio endpoint ${endpoint} failed: ${response.error}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message === 'Request timeout') {
        throw new Error(
          'Studio plugin connection timeout. Troubleshooting steps:\n' +
          '1. Make sure Roblox Studio is open with your place.\n' +
          '2. In Studio: Game Settings -> Security -> Enable "Allow HTTP Requests".\n' +
          '3. In Studio Plugins toolbar: click "MCP Server" button, then click "Connect".\n' +
          '4. If still failing, fully restart Roblox Studio after plugin installation.'
        );
      }
      throw error;
    }
  }
}
