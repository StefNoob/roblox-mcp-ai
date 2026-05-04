import { Jimp } from 'jimp';

type JimpInstance = Awaited<ReturnType<typeof Jimp.read>>;

export interface ColorInfo {
  hex: string;
  r: number;
  g: number;
  b: number;
  a: number;
  frequency: number;
  percentage: number;
  role?: 'background' | 'primary' | 'secondary' | 'accent' | 'text';
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'header' | 'content' | 'footer' | 'sidebar' | 'modal';
  confidence: number;
}

export interface UIElement {
  id: string;
  type: 'button' | 'text' | 'image' | 'container' | 'input' | 'icon';
  bounds: { x: number; y: number; width: number; height: number };
  color: string;
  text?: string;
  confidence: number;
  children: UIElement[];
  parentId?: string;
  zIndex: number;
}

export interface HierarchyNode {
  id: string;
  name: string;
  type: string;
  bounds: { x: number; y: number; width: number; height: number };
  relativeBounds: { x: number; y: number; width: number; height: number };
  color: string;
  children: HierarchyNode[];
  attributes: Record<string, any>;
}

export interface RobloxUISpec {
  className: string;
  name: string;
  properties: Record<string, any>;
  children: RobloxUISpec[];
}

export interface ParseResult {
  metadata: {
    width: number;
    height: number;
    format: string;
    analyzedAt: string;
    processingTimeMs: number;
  };
  colorPalette: ColorInfo[];
  layout: {
    regions: Region[];
    dominantLayout: 'vertical' | 'horizontal' | 'grid' | 'freeform';
  };
  elements: UIElement[];
  hierarchy: HierarchyNode;
  robloxOutput: RobloxUISpec;
}

interface ParsingOptions {
  detectText: boolean;
  detectButtons: boolean;
  minElementSize: number;
  colorClusterCount: number;
}

const DEFAULT_OPTIONS: ParsingOptions = {
  detectText: true,
  detectButtons: true,
  minElementSize: 20,
  colorClusterCount: 8,
};

export class UIReferenceParser {
  private image: JimpInstance | null = null;
  private width: number = 0;
  private height: number = 0;
  private options: ParsingOptions;

  constructor(options?: Partial<ParsingOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private pixelToRgba(pixel: number): { r: number; g: number; b: number; a: number } {
    return {
      r: (pixel >> 24) & 0xff,
      g: (pixel >> 16) & 0xff,
      b: (pixel >> 8) & 0xff,
      a: pixel & 0xff,
    };
  }

  private rgbaToHex(r: number, g: number, b: number): string {
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  }

  async loadImage(source: string | Buffer): Promise<void> {
    let imageData: Buffer;
    if (typeof source === 'string') {
      if (source.startsWith('data:')) {
        const base64Data = source.replace(/^data:image\/\w+;base64,/, '');
        imageData = Buffer.from(base64Data, 'base64');
      } else {
        imageData = Buffer.from(source);
      }
    } else {
      imageData = source;
    }
    this.image = await Jimp.read(imageData);
    this.width = this.image.width;
    this.height = this.image.height;
  }

  async parse(source: string | Buffer): Promise<ParseResult> {
    const startTime = Date.now();
    await this.loadImage(source);

    const colorPalette = this.extractColorPalette();
    const regions = this.detectRegions(colorPalette);
    const elements = await this.detectElements();
    const hierarchy = this.buildHierarchy(elements);
    const layoutType = this.detectLayoutType(regions, elements);
    const robloxOutput = this.toRobloxUIJson(hierarchy, colorPalette);

    return {
      metadata: {
        width: this.width,
        height: this.height,
        format: 'png',
        analyzedAt: new Date().toISOString(),
        processingTimeMs: Date.now() - startTime,
      },
      colorPalette,
      layout: {
        regions,
        dominantLayout: layoutType,
      },
      elements,
      hierarchy,
      robloxOutput,
    };
  }

  private extractColorPalette(): ColorInfo[] {
    if (!this.image) throw new Error('No image loaded');

    const pixels: Map<string, number> = new Map();

    this.image.scan(0, 0, this.width, this.height, (x, y, idx) => {
      const r = this.image!.bitmap.data[idx];
      const g = this.image!.bitmap.data[idx + 1];
      const b = this.image!.bitmap.data[idx + 2];
      const a = this.image!.bitmap.data[idx + 3];

      if (a === 0) return;

      const quantizedR = Math.round(r / 32) * 32;
      const quantizedG = Math.round(g / 32) * 32;
      const quantizedB = Math.round(b / 32) * 32;
      const quantizedA = Math.round(a / 32) * 32;
      const key = `${quantizedR},${quantizedG},${quantizedB},${quantizedA}`;

      pixels.set(key, (pixels.get(key) || 0) + 1);
    });

    const sorted = Array.from(pixels.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.options.colorClusterCount);

    const total = Array.from(pixels.values()).reduce((a, b) => a + b, 0);
    const colors: ColorInfo[] = sorted.map(([key]) => {
      const [r, g, b, a] = key.split(',').map(Number);
      return {
        hex: this.rgbaToHex(r, g, b),
        r, g, b, a,
        frequency: pixels.get(key) || 0,
        percentage: ((pixels.get(key) || 0) / total) * 100,
      };
    });

    const backgroundIdx = colors.findIndex(c => c.percentage > 20);
    if (backgroundIdx >= 0) {
      colors[backgroundIdx].role = 'background';
    }

    const highContrast = colors.filter(c => this.getLuminance(c) > 0.7);
    if (highContrast.length > 0) {
      const textCandidate = highContrast.reduce((a, b) => a.percentage < b.percentage ? a : b);
      textCandidate.role = 'text';
    }

    return colors;
  }

  private getLuminance(color: ColorInfo): number {
    return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
  }

  private detectRegions(colorPalette: ColorInfo[]): Region[] {
    const regions: Region[] = [];

    regions.push({
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
      type: 'content',
      confidence: 0.9,
    });

    const horizonY = Math.floor(this.height * 0.15);
    if (horizonY > 50) {
      regions.push({
        x: 0,
        y: 0,
        width: this.width,
        height: horizonY,
        type: 'header',
        confidence: 0.8,
      });
    }

    const footerY = Math.floor(this.height * 0.85);
    if (this.height - footerY > 50) {
      regions.push({
        x: 0,
        y: footerY,
        width: this.width,
        height: this.height - footerY,
        type: 'footer',
        confidence: 0.75,
      });
    }

    return regions;
  }

  private async detectElements(): Promise<UIElement[]> {
    if (!this.image) throw new Error('No image loaded');

    const elements: UIElement[] = [];
    const edges = this.detectEdges();
    const contours = this.findContours(edges);

    let elementId = 1;

    for (const contour of contours) {
      const bounds = this.getContourBounds(contour);
      if (bounds.width < this.options.minElementSize || bounds.height < this.options.minElementSize) {
        continue;
      }

      const aspectRatio = bounds.width / bounds.height;
      let type: UIElement['type'] = 'container';
      let confidence = 0.5;

      if (aspectRatio >= 1.5 && aspectRatio <= 5) {
        type = 'button';
        confidence = 0.8;
      } else if (aspectRatio > 5 && bounds.height < 40) {
        type = 'text';
        confidence = 0.7;
      } else if (aspectRatio >= 0.8 && aspectRatio <= 1.2 && bounds.width < 100) {
        type = 'icon';
        confidence = 0.6;
      } else if (bounds.width > this.width * 0.8 && bounds.height > this.height * 0.6) {
        type = 'container';
        confidence = 0.9;
      }

      const avgColor = this.getRegionColor(bounds);

      elements.push({
        id: `el_${elementId++}`,
        type,
        bounds,
        color: avgColor,
        confidence,
        children: [],
        zIndex: elements.length,
      });
    }

    return elements;
  }

  private detectEdges(): number[][] {
    if (!this.image) throw new Error('No image loaded');

    const gray: number[][] = [];
    for (let y = 0; y < this.height; y++) {
      gray[y] = [];
      for (let x = 0; x < this.width; x++) {
        const pixel = this.image.getPixelColor(x, y);
        const { r, g, b } = this.pixelToRgba(pixel);
        gray[y][x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }

    const sobelX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
    const sobelY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];

    const edges: number[][] = Array.from({ length: this.height }, () => Array(this.width).fill(0));
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        let gx = 0, gy = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            gx += gray[y + ky][x + kx] * sobelX[ky + 1][kx + 1];
            gy += gray[y + ky][x + kx] * sobelY[ky + 1][kx + 1];
          }
        }
        edges[y][x] = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      }
    }

    return edges;
  }

  private findContours(edges: number[][]): { x: number; y: number }[][] {
    const threshold = 50;
    const contours: { x: number; y: number }[][] = [];
    const visited: boolean[][] = Array(this.height).fill(null).map(() => Array(this.width).fill(false));

    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        if (edges[y][x] > threshold && !visited[y][x]) {
          const contour = this.traceContour(edges, x, y, threshold, visited);
          if (contour.length > 20) {
            contours.push(contour);
          }
        }
      }
    }

    return contours;
  }

  private traceContour(
    edges: number[][],
    startX: number,
    startY: number,
    threshold: number,
    visited: boolean[][]
  ): { x: number; y: number }[] {
    const contour: { x: number; y: number }[] = [];
    const stack: [number, number][] = [[startX, startY]];

    while (stack.length > 0 && contour.length < 1000) {
      const [x, y] = stack.pop()!;
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
      if (visited[y][x]) continue;
      if (edges[y][x] < threshold) continue;

      visited[y][x] = true;
      contour.push({ x, y });

      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    return contour;
  }

  private getContourBounds(contour: { x: number; y: number }[]): { x: number; y: number; width: number; height: number } {
    if (contour.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of contour) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  private getRegionColor(bounds: { x: number; y: number; width: number; height: number }): string {
    if (!this.image) return '#000000';

    let r = 0, g = 0, b = 0, count = 0;
    const stepX = Math.max(1, Math.floor(bounds.width / 10));
    const stepY = Math.max(1, Math.floor(bounds.height / 10));

    for (let y = bounds.y; y < bounds.y + bounds.height && y < this.height; y += stepY) {
      for (let x = bounds.x; x < bounds.x + bounds.width && x < this.width; x += stepX) {
        const pixel = this.image.getPixelColor(x, y);
        const { r: pr, g: pg, b: pb } = this.pixelToRgba(pixel);
        r += pr;
        g += pg;
        b += pb;
        count++;
      }
    }

    if (count === 0) return '#000000';

    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);

    return this.rgbaToHex(r, g, b);
  }

  private buildHierarchy(elements: UIElement[]): HierarchyNode {
    const sortedByArea = [...elements].sort((a, b) =>
      (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height)
    );

    const nodes: Map<string, HierarchyNode> = new Map();

    for (const el of sortedByArea) {
      nodes.set(el.id, {
        id: el.id,
        name: `${el.type}_${el.id}`,
        type: el.type,
        bounds: el.bounds,
        relativeBounds: {
          x: el.bounds.x / this.width,
          y: el.bounds.y / this.height,
          width: el.bounds.width / this.width,
          height: el.bounds.height / this.height,
        },
        color: el.color,
        children: [],
        attributes: {
          confidence: el.confidence,
          area: el.bounds.width * el.bounds.height,
        },
      });
    }

    const roots: HierarchyNode[] = [];

    for (const el of sortedByArea) {
      const node = nodes.get(el.id)!;
      let parent: HierarchyNode | null = null;

      for (const [otherId, otherNode] of nodes) {
        if (otherId === el.id) continue;

        if (this.isContaining(otherNode.bounds, el.bounds) &&
            (otherNode.bounds.width * otherNode.bounds.height) > (el.bounds.width * el.bounds.height)) {
          if (!parent || this.isContaining(parent.bounds, otherNode.bounds)) {
            parent = otherNode;
          }
        }
      }

      if (parent) {
        parent.children.push(node);
        el.parentId = parent.id;
        
        node.relativeBounds = {
          x: (node.bounds.x - parent.bounds.x) / parent.bounds.width,
          y: (node.bounds.y - parent.bounds.y) / parent.bounds.height,
          width: node.bounds.width / parent.bounds.width,
          height: node.bounds.height / parent.bounds.height,
        };
      } else {
        roots.push(node);
      }
    }

    const rootNode: HierarchyNode = {
      id: 'root',
      name: 'ScreenGui',
      type: 'ScreenGui',
      bounds: { x: 0, y: 0, width: this.width, height: this.height },
      relativeBounds: { x: 0, y: 0, width: 1, height: 1 },
      color: '#FFFFFF',
      children: roots,
      attributes: {},
    };

    return rootNode;
  }

  private isContaining(outer: { x: number; y: number; width: number; height: number },
                      inner: { x: number; y: number; width: number; height: number }): boolean {
    return inner.x >= outer.x &&
           inner.y >= outer.y &&
           inner.x + inner.width <= outer.x + outer.width &&
           inner.y + inner.height <= outer.y + outer.height;
  }

  private detectLayoutType(regions: Region[], elements: UIElement[]): 'vertical' | 'horizontal' | 'grid' | 'freeform' {
    const containers = elements.filter(e => e.type === 'container' && e.bounds.width > 100);

    if (containers.length === 0) return 'freeform';

    const verticalCount = containers.filter(c => c.bounds.width > c.bounds.height * 0.8).length;
    const horizontalCount = containers.filter(c => c.bounds.height > c.bounds.width * 0.8).length;

    if (verticalCount > horizontalCount && verticalCount > containers.length / 2) return 'vertical';
    if (horizontalCount > verticalCount && horizontalCount > containers.length / 2) return 'horizontal';

    return 'freeform';
  }

  private toRobloxUIJson(hierarchy: HierarchyNode, colorPalette: ColorInfo[]): RobloxUISpec {
    const buildChildren = (node: HierarchyNode): RobloxUISpec[] => {
      return node.children.map(child => ({
        className: this.mapTypeToRobloxClass(child.type),
        name: this.sanitizeName(child.name),
        properties: {
          Size: this.formatSize(child.relativeBounds),
          Position: this.formatPosition(child.relativeBounds),
          BackgroundColor3: this.hexToColor3(child.color),
          BorderSizePixel: 0,
          ZIndex: node.children.indexOf(child) + 1,
          ...this.getClassProperties(child),
        },
        children: buildChildren(child),
      }));
    };

    return {
      className: 'ScreenGui',
      name: 'UIRefReference',
      properties: {
        ResetOnSpawn: false,
        ZIndexBehavior: 'Sibling',
      },
      children: buildChildren(hierarchy),
    };
  }

  private mapTypeToRobloxClass(type: string): string {
    const map: Record<string, string> = {
      button: 'TextButton',
      text: 'TextLabel',
      container: 'Frame',
      image: 'ImageLabel',
      input: 'TextBox',
      icon: 'ImageLabel',
    };
    return map[type] || 'Frame';
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_|_$/g, '') || 'Element';
  }

  private formatSize(bounds: { x: number; y: number; width: number; height: number }): string {
    return `UDim2.new(${bounds.width.toFixed(3)}, 0, ${bounds.height.toFixed(3)}, 0)`;
  }

  private formatPosition(bounds: { x: number; y: number; width: number; height: number }): string {
    return `UDim2.new(${bounds.x.toFixed(3)}, 0, ${bounds.y.toFixed(3)}, 0)`;
  }

  private hexToColor3(hex: string): string {
    const cleanHex = hex.replace('#', '');
    if (cleanHex.length < 6) return 'Color3.new(0, 0, 0)';
    const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
    const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
    const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
    return `Color3.new(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)})`;
  }

  private getClassProperties(node: HierarchyNode): Record<string, any> {
    const props: Record<string, any> = {};

    switch (node.type) {
      case 'button':
      case 'text':
        props.Font = 'GothamBold';
        props.TextSize = 18;
        props.TextColor3 = 'Color3.new(1, 1, 1)';
        break;
    }

    return props;
  }
}

export async function parseUIReference(
  imageSource: string | Buffer,
  options?: Partial<ParsingOptions>
): Promise<ParseResult> {
  const parser = new UIReferenceParser(options);
  return parser.parse(imageSource);
}