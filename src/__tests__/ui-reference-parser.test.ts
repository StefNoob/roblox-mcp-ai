import { unlinkSync } from 'fs';
import { Jimp } from 'jimp';
import { UIReferenceParser } from '../tools/ui-reference-parser.js';

async function createSampleTestImage(): Promise<Buffer> {
  const width = 400;
  const height = 300;

  const img = new Jimp({ width, height, data: Buffer.alloc(width * height * 4, 0xFFFFFFFF) });

  const headerY = 50;
  for (let y = 0; y < headerY; y++) {
    for (let x = 0; x < width; x++) {
      img.setPixelColor(0x4477AAFF, x, y);
    }
  }

  for (let y = headerY; y < height - 40; y++) {
    for (let x = 0; x < width; x++) {
      img.setPixelColor(0xFFFFFFEE, x, y);
    }
  }

  for (let y = height - 40; y < height; y++) {
    for (let x = 0; x < width; x++) {
      img.setPixelColor(0x333333FF, x, y);
    }
  }

  const button1X = 50, button1Y = 100;
  for (let y = button1Y; y < button1Y + 40; y++) {
    for (let x = button1X; x < button1X + 120; x++) {
      img.setPixelColor(0x4488CCFF, x, y);
    }
  }

  const button2X = 200, button2Y = 100;
  for (let y = button2Y; y < button2Y + 40; y++) {
    for (let x = button2X; x < button2X + 120; x++) {
      img.setPixelColor(0x44BB88FF, x, y);
    }
  }

  const textX = 50, textY = 160;
  for (let y = textY; y < textY + 25; y++) {
    for (let x = textX; x < textX + 200; x++) {
      img.setPixelColor(0x222222FF, x, y);
    }
  }

  const tempPath = 'C:/Users/stefi/AppData/Local/Temp/test-ui-parser.png';
  await img.write(tempPath as `${string}.png`);
  const img2 = await Jimp.read(tempPath);
  const buffer = await img2.getBuffer('image/png');
  unlinkSync(tempPath);

  return buffer;
}

describe('UIReferenceParser', () => {
  it('should parse ui reference image', async () => {
    const imageBuffer = await createSampleTestImage();
    const parser = new UIReferenceParser({
      colorClusterCount: 6,
      minElementSize: 15,
    });

    const result = await parser.parse(imageBuffer);

    expect(result.metadata.width).toBe(400);
    expect(result.metadata.height).toBe(300);
    expect(result.colorPalette.length).toBeGreaterThan(0);
    expect(result.elements.length).toBeGreaterThan(0);
  });

  it('should calculate relativeBounds of nested children relative to their parent', () => {
    const parser = new UIReferenceParser({ colorClusterCount: 2, minElementSize: 10 });
    // mock the width and height of the root image
    (parser as any).width = 400;
    (parser as any).height = 300;

    const mockElements = [
      {
        id: 'parent',
        type: 'container',
        bounds: { x: 50, y: 50, width: 300, height: 200 },
        color: '#FFFFFF',
        confidence: 1
      },
      {
        id: 'child',
        type: 'button',
        bounds: { x: 100, y: 100, width: 50, height: 50 },
        color: '#000000',
        confidence: 1
      }
    ];

    const hierarchy = (parser as any).buildHierarchy(mockElements);

    // The root node children should be the parent
    expect(hierarchy.children.length).toBe(1);
    const parentNode = hierarchy.children[0];
    expect(parentNode.id).toBe('parent');
    
    // Parent's relativeBounds should be relative to screen (400x300)
    expect(parentNode.relativeBounds.width).toBeCloseTo(300 / 400);
    expect(parentNode.relativeBounds.height).toBeCloseTo(200 / 300);

    // The parent should have the child
    expect(parentNode.children.length).toBe(1);
    const childNode = parentNode.children[0];
    expect(childNode.id).toBe('child');

    // Child's relativeBounds should be relative to the PARENT (300x200), not the screen
    // width: 50 / 300 = 0.1666...
    // x: (100 - 50) / 300 = 50 / 300 = 0.1666...
    expect(childNode.relativeBounds.width).toBeCloseTo(50 / 300);
    expect(childNode.relativeBounds.height).toBeCloseTo(50 / 200);
    expect(childNode.relativeBounds.x).toBeCloseTo(50 / 300);
    expect(childNode.relativeBounds.y).toBeCloseTo(50 / 200);
  });

  it('should handle real-world noise tolerance', async () => {
    const width = 100, height = 100;
    const img = new Jimp({ width, height, data: Buffer.alloc(width * height * 4, 0xFFFFFFFF) });
    
    for (let y = 20; y < 80; y++) {
      for (let x = 20; x < 80; x++) {
        const noise = Math.floor(Math.random() * 20) - 10;
        const r = Math.min(255, Math.max(0, 0x44 + noise));
        const g = Math.min(255, Math.max(0, 0x88 + noise));
        const b = Math.min(255, Math.max(0, 0xCC + noise));
        const color = ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;
        img.setPixelColor(color, x, y);
      }
    }
    
    for (let i = 0; i < 50; i++) {
      const rx = Math.floor(Math.random() * width);
      const ry = Math.floor(Math.random() * height);
      img.setPixelColor(Math.random() > 0.5 ? 0xFFFFFFFF : 0x000000FF, rx, ry);
    }
    
    const tempPath = 'C:/Users/stefi/AppData/Local/Temp/test-ui-parser-noise.png';
    await img.write(tempPath as `${string}.png`);
    const img2 = await Jimp.read(tempPath);
    const buffer = await img2.getBuffer('image/png');
    unlinkSync(tempPath);

    const parser = new UIReferenceParser({ colorClusterCount: 3, minElementSize: 15 });
    const result = await parser.parse(buffer);
    
    const largeElements = result.elements.filter(e => e.bounds.width > 20);
    expect(largeElements.length).toBeGreaterThan(0);
    expect(largeElements[0].bounds.width).toBeGreaterThanOrEqual(40);
  });

  it('should detect alpha transparency correctly', async () => {
    const width = 100, height = 100;
    const img = new Jimp({ width, height, data: Buffer.alloc(width * height * 4, 0xFFFFFFFF) });
    
    for (let y = 20; y < 80; y++) {
      for (let x = 20; x < 80; x++) {
        img.setPixelColor(0xFF000080, x, y);
      }
    }
    
    const tempPath = 'C:/Users/stefi/AppData/Local/Temp/test-ui-parser-alpha.png';
    await img.write(tempPath as `${string}.png`);
    const img2 = await Jimp.read(tempPath);
    const buffer = await img2.getBuffer('image/png');
    unlinkSync(tempPath);

    const parser = new UIReferenceParser({ colorClusterCount: 2, minElementSize: 10 });
    const result = await parser.parse(buffer);
    
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.colorPalette.some(c => c.a < 255)).toBe(true);
  });
});