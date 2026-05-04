import { BridgeService } from '../bridge-service.js';
import { StudioHttpClient } from './studio-client.js';
import {
  type UIGenerationRequest,
  type UIGenerationResult,
  type UIPreviewData,
  createDefaultScalingConfig,
} from './schemas/ui-generation.js';

export class UIGeneratorTool {
  private bridge: BridgeService;
  private client: StudioHttpClient;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
    this.client = new StudioHttpClient(bridge);
  }

  async generateUI(request: UIGenerationRequest): Promise<UIGenerationResult> {
    this.validateRequest(request);

    const response = await this.client.request('/api/generate-ui', {
      uiContainer: request.uiContainer,
      scalingConfig: request.scalingConfig,
      metadata: request.metadata || {},
    });

    return this.parseGenerationResult(response);
  }

  async previewUI(request: UIGenerationRequest): Promise<UIPreviewData> {
    this.validateRequest(request);

    const container = request.uiContainer;
    const elementCount = this.countElements(container.elements);
    const animationsCount = this.countAnimations(container.elements);
    const estimatedComplexity = this.estimateComplexity(elementCount, animationsCount, container.elements);

    return {
      containerJson: JSON.stringify(container, null, 2),
      elementCount,
      estimatedComplexity,
      animationsCount,
    };
  }

  async validateUIRequest(request: UIGenerationRequest): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!request.uiContainer) {
      errors.push('uiContainer is required');
    } else {
      this.validateContainer(request.uiContainer, errors, warnings);
    }

    if (!request.scalingConfig) {
      warnings.push('scalingConfig not provided, using defaults');
    } else {
      this.validateScalingConfig(request.scalingConfig, errors, warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateRequest(request: UIGenerationRequest): void {
    if (!request || typeof request !== 'object') {
      throw new Error('Invalid UI generation request: must be an object');
    }
    if (!request.uiContainer || typeof request.uiContainer !== 'object') {
      throw new Error('Invalid UI generation request: uiContainer is required and must be an object');
    }
    if (!Array.isArray(request.uiContainer.elements)) {
      throw new Error('Invalid UI generation request: uiContainer.elements must be an array');
    }
  }

  private validateContainer(
    container: UIGenerationRequest['uiContainer'],
    errors: string[],
    warnings: string[]
  ): void {
    const validTypes = ['ScreenGui', 'BillboardGui', 'SurfaceGui', 'Frame', 'ScrollingFrame'];
    if (!validTypes.includes(container.type)) {
      errors.push(`Invalid container type: ${container.type}. Must be one of: ${validTypes.join(', ')}`);
    }

    if (!container.name || typeof container.name !== 'string') {
      errors.push('Container name is required and must be a string');
    }

    const seenIds = new Set<string>();
    if (container.id) {
      seenIds.add(container.id);
    }
    
    for (const element of container.elements) {
      this.validateElement(element, errors, warnings, seenIds, container.type);
    }
  }

  private validateElement(
    element: any,
    errors: string[],
    warnings: string[],
    seenIds: Set<string>,
    containerType: string
  ): void {
    const validTypes = ['Frame', 'TextLabel', 'TextButton', 'ImageLabel', 'ImageButton', 'ScrollingFrame', 'ViewportFrame'];
    if (!element.id || typeof element.id !== 'string') {
      errors.push('Element missing or invalid id');
      return;
    }

    if (seenIds.has(element.id)) {
      errors.push(`Duplicate element id: ${element.id}`);
      return;
    }
    seenIds.add(element.id);

    if (!validTypes.includes(element.type)) {
      errors.push(`Invalid element type: ${element.type}. Must be one of: ${validTypes.join(', ')}`);
    }

    if (element.parentId && !seenIds.has(element.parentId)) {
      warnings.push(`Element ${element.id} references parentId ${element.parentId} that will not be created before it`);
    }

    if (element.content?.text && element.textStyle) {
      this.validateTextStyle(element.textStyle, warnings);
    }

    if (element.buttonConfig && element.type !== 'TextButton' && element.type !== 'ImageButton') {
      warnings.push(`Element ${element.id} has buttonConfig but is type ${element.type}`);
    }

    if (element.animations) {
      for (const anim of element.animations) {
        this.validateAnimation(anim, element.id, errors, warnings);
      }
    }
  }

  private validateTextStyle(style: any, warnings: string[]): void {
    const validFonts = ['GothamMedium', 'GothamBold', 'GothamSemibold', 'Roboto', 'RobotoMono', 'SourceSans'];
    if (style.font && !validFonts.includes(style.font)) {
      warnings.push(`Non-standard font: ${style.font}`);
    }
    if (style.textSize !== undefined && (style.textSize < 1 || style.textSize > 1000)) {
      warnings.push(`textSize ${style.textSize} is outside typical range (1-1000)`);
    }
  }

  private validateAnimation(anim: any, elementId: string, errors: string[], warnings: string[]): void {
    const validEasingStyles = ['Linear', 'Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ', 'Back', 'Bounce', 'Elastic'];
    const validEasingDirections = ['In', 'Out', 'InOut'];
    const validProperties = ['Size', 'Position', 'BackgroundTransparency', 'TextTransparency', 'Rotation'];

    if (!validEasingStyles.includes(anim.easingStyle)) {
      errors.push(`Invalid easingStyle: ${anim.easingStyle} for animation on ${elementId}`);
    }
    if (!validEasingDirections.includes(anim.easingDirection)) {
      errors.push(`Invalid easingDirection: ${anim.easingDirection} for animation on ${elementId}`);
    }
    if (!validProperties.includes(anim.property)) {
      warnings.push(`Non-standard property animation: ${anim.property} on ${elementId}`);
    }
    if (anim.duration !== undefined && (anim.duration < 0 || anim.duration > 60)) {
      warnings.push(`Animation duration ${anim.duration}s is outside typical range (0-60s)`);
    }
  }

  private validateScalingConfig(config: any, errors: string[], warnings: string[]): void {
    if (config.referenceWidth !== undefined && (config.referenceWidth < 100 || config.referenceWidth > 10000)) {
      errors.push('referenceWidth must be between 100 and 10000');
    }
    if (config.referenceHeight !== undefined && (config.referenceHeight < 100 || config.referenceHeight > 10000)) {
      errors.push('referenceHeight must be between 100 and 10000');
    }
    const validScaleModes = ['exact', 'proportional', 'responsive'];
    if (!validScaleModes.includes(config.scaleMode)) {
      errors.push(`Invalid scaleMode: ${config.scaleMode}. Must be one of: ${validScaleModes.join(', ')}`);
    }
    const validAnchorPoints = ['topLeft', 'topCenter', 'topRight', 'centerLeft', 'center', 'centerRight', 'bottomLeft', 'bottomCenter', 'bottomRight'];
    if (config.coordinateReference?.anchorPoint && !validAnchorPoints.includes(config.coordinateReference.anchorPoint)) {
      errors.push(`Invalid anchorPoint: ${config.coordinateReference.anchorPoint}`);
    }
  }

  private countElements(elements: any[]): number {
    let count = 0;
    for (const el of elements) {
      count += 1;
      if (el.elements) {
        count += this.countElements(el.elements);
      }
    }
    return count;
  }

  private countAnimations(elements: any[]): number {
    let count = 0;
    for (const el of elements) {
      if (el.animations) {
        count += el.animations.length;
      }
      if (el.elements) {
        count += this.countAnimations(el.elements);
      }
    }
    return count;
  }

  private estimateComplexity(elementCount: number, animationsCount: number, elements: any[]): 'simple' | 'medium' | 'complex' {
    let maxNesting = 0;
    for (const el of elements) {
      const nesting = this.getNestingDepth(el);
      maxNesting = Math.max(maxNesting, nesting);
    }

    const complexityScore = elementCount + animationsCount * 2 + maxNesting * 3;
    if (complexityScore < 20) return 'simple';
    if (complexityScore < 50) return 'medium';
    return 'complex';
  }

  private getNestingDepth(element: any, depth: number = 0): number {
    let maxChildDepth = depth;
    if (element.elements) {
      for (const child of element.elements) {
        maxChildDepth = Math.max(maxChildDepth, this.getNestingDepth(child, depth + 1));
      }
    }
    return maxChildDepth;
  }

  private parseGenerationResult(response: any): UIGenerationResult {
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid response from Studio plugin');
    }
    return {
      success: Boolean(response.success),
      rootInstancePath: String(response.rootInstancePath || ''),
      createdInstances: Array.isArray(response.createdInstances) ? response.createdInstances : [],
      errors: Array.isArray(response.errors) ? response.errors : undefined,
      warnings: Array.isArray(response.warnings) ? response.warnings : undefined,
    };
  }
}

export function createSampleUIRequest(): UIGenerationRequest {
  return {
    uiContainer: {
      id: 'mainMenu',
      type: 'ScreenGui',
      name: 'MainMenu',
      displayOrder: 0,
      enabled: true,
      elements: [
        {
          id: 'background',
          type: 'Frame',
          name: 'Background',
          position: { type: 'centered', x: 0, y: 0 },
          size: { type: 'scale', scaleX: 1, scaleY: 1 },
          backgroundColor: { r: 10, g: 15, b: 26 },
          corner: { radius: 0 },
          zIndex: 1,
        },
        {
          id: 'titleCard',
          type: 'Frame',
          name: 'TitleCard',
          position: { type: 'absolute', x: 100, y: 50 },
          size: { type: 'absolute', width: 400, height: 80 },
          parentId: 'background',
          backgroundColor: { r: 22, g: 34, b: 58 },
          corner: { radius: 12 },
          stroke: { color: '#FFFFFF', thickness: 1, joins: 'Round' },
          zIndex: 2,
        },
        {
          id: 'titleText',
          type: 'TextLabel',
          name: 'TitleText',
          position: { type: 'absolute', x: 0, y: 0 },
          size: { type: 'scale', scaleX: 1, scaleY: 1 },
          parentId: 'titleCard',
          textStyle: {
            font: 'GothamBold',
            textSize: 32,
            textColor: { r: 230, g: 238, b: 255 },
            textXAlignment: 'Center',
            textYAlignment: 'Center',
          },
          content: {
            text: 'Game Title',
          },
          zIndex: 3,
        },
        {
          id: 'playButton',
          type: 'TextButton',
          name: 'PlayButton',
          position: { type: 'absolute', x: 150, y: 200 },
          size: { type: 'absolute', width: 200, height: 60 },
          parentId: 'background',
          backgroundColor: { r: 52, g: 211, b: 153 },
          corner: { radius: 8 },
          textStyle: {
            font: 'GothamSemibold',
            textSize: 20,
            textColor: { r: 10, g: 15, b: 26 },
            textXAlignment: 'Center',
            textYAlignment: 'Center',
          },
          content: {
            text: 'Play',
          },
          buttonConfig: {
            hoverColor: { r: 40, g: 180, b: 130 },
            clickColor: { r: 35, g: 160, b: 110 },
          },
          animations: [
            {
              type: 'tween',
              easingStyle: 'Quad',
              easingDirection: 'Out',
              duration: 0.15,
              property: 'BackgroundColor3',
              startValue: { r: 52, g: 211, b: 153 },
              endValue: { r: 40, g: 180, b: 130 },
            },
          ],
          zIndex: 4,
        },
        {
          id: 'settingsButton',
          type: 'TextButton',
          name: 'SettingsButton',
          position: { type: 'absolute', x: 150, y: 280 },
          size: { type: 'absolute', width: 200, height: 60 },
          parentId: 'background',
          backgroundColor: { r: 22, g: 34, b: 58 },
          corner: { radius: 8 },
          stroke: { color: '#FFFFFF', thickness: 1, joins: 'Round' },
          textStyle: {
            font: 'GothamSemibold',
            textSize: 18,
            textColor: { r: 230, g: 238, b: 255 },
            textXAlignment: 'Center',
            textYAlignment: 'Center',
          },
          content: {
            text: 'Settings',
          },
          buttonConfig: {
            hoverColor: { r: 35, g: 52, b: 80 },
            clickColor: { r: 28, g: 42, b: 65 },
          },
          zIndex: 4,
        },
        {
          id: 'buttonRow',
          type: 'Frame',
          name: 'ButtonRow',
          position: { type: 'absolute', x: 50, y: 400 },
          size: { type: 'absolute', width: 500, height: 100 },
          parentId: 'background',
          layoutConfig: {
            layoutType: 'Horizontal',
            padding: 20,
            spacing: 30,
            fillDirection: 'Horizontal',
          },
          zIndex: 3,
        },
      ],
    },
    scalingConfig: createDefaultScalingConfig(),
    metadata: {
      parserVersion: '1.0.0',
      generationTimestamp: Date.now(),
    },
  };
}