import { jest } from '@jest/globals';
import { UIGeneratorTool, createSampleUIRequest } from '../tools/ui-generator.js';
import { BridgeService } from '../bridge-service.js';
import type { UIElements } from '../tools/schemas/ui-generation.js';

describe('UIGeneratorTool', () => {
  let tool: UIGeneratorTool;

  beforeEach(() => {
    const bridgeService = new BridgeService();
    tool = new UIGeneratorTool(bridgeService);
  });

  it('should not emit warnings for elements referencing container id as parent', async () => {
    const request = createSampleUIRequest();
    
    // Make sure we have an element that references the container ID
    const containerId = request.uiContainer.id;
    expect(containerId).toBeDefined();
    
    // Manually set an element's parentId to the container ID
    const element = request.uiContainer.elements[0] as UIElements;
    element.parentId = containerId;

    expect(element.parentId).toBe(containerId);

    const validation = await tool.validateUIRequest(request);
    
    // The warning "Element X references parentId Y that will not be created before it" should not be present
    const parentWarnings = validation.warnings.filter(w => w.includes('references parentId'));
    expect(parentWarnings).toHaveLength(0);
  });
});
