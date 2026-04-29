import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

export type SummaryStatus = 'missing' | 'fresh' | 'stale';
export type StructureMapMode = 'compact' | 'standard' | 'verbose';

export interface StructureMapNodeRecord {
  path: string;
  name?: string;
  className: string;
  parentPath?: string;
  childPaths?: string[];
  childCount?: number;
  hasChildren?: boolean;
  hasSource?: boolean;
  scriptType?: string;
  enabled?: boolean;
  tags?: string[];
  attributeNames?: string[];
  sourceHash?: string;
  summaryStatus?: SummaryStatus;
  subsystem?: string;
}

export interface ScriptSummaryRecord {
  path: string;
  sourceHash: string;
  summaryShort: string;
  summaryLong?: string;
  purpose?: string;
  exports?: string[];
  dependencies: string[];
  servicesUsed: string[];
  sideEffects: string[];
  subsystem?: string;
  updatedAt: number;
}

export interface PersistedStructureMapSnapshot {
  placeId: number;
  placeName: string;
  version: number;
  updatedAt: number;
  roots: string[];
  nodesByPath: Record<string, StructureMapNodeRecord>;
  scriptInventory: string[];
  summaryIndex: Record<string, ScriptSummaryRecord>;
}

export function mergeSummaryIntoSnapshot(snapshot: PersistedStructureMapSnapshot): PersistedStructureMapSnapshot {
  snapshot.summaryIndex = snapshot.summaryIndex || {};
  snapshot.scriptInventory = snapshot.scriptInventory || [];
  for (const [nodePath, node] of Object.entries(snapshot.nodesByPath)) {
    if (!node.hasSource) {
      node.summaryStatus = undefined;
      continue;
    }
    const summary = snapshot.summaryIndex[nodePath];
    if (!summary) {
      node.summaryStatus = 'missing';
      continue;
    }
    node.summaryStatus = summary.sourceHash === node.sourceHash ? 'fresh' : 'stale';
  }
  return snapshot;
}

export class StructureMapCache {
  private rootDir: string;
  private relativeDir: string;

  constructor(rootDir: string, relativeDir: string = path.join('.studio-cli', 'cache', 'structure-map')) {
    this.rootDir = rootDir;
    this.relativeDir = relativeDir;
  }

  getDirectory() {
    return path.join(this.rootDir, this.relativeDir);
  }

  getSnapshotPath(placeId: number) {
    return path.join(this.getDirectory(), `${placeId}.json`);
  }

  async saveStructureMap(snapshot: PersistedStructureMapSnapshot) {
    await mkdir(this.getDirectory(), { recursive: true });
    const merged = mergeSummaryIntoSnapshot(snapshot);
    await writeFile(this.getSnapshotPath(snapshot.placeId), JSON.stringify(merged, null, 2), 'utf8');
  }

  async loadStructureMap(placeId: number): Promise<PersistedStructureMapSnapshot | null> {
    try {
      const raw = await readFile(this.getSnapshotPath(placeId), 'utf8');
      return mergeSummaryIntoSnapshot(JSON.parse(raw) as PersistedStructureMapSnapshot);
    } catch {
      return null;
    }
  }

  async getCacheStats(placeId?: number) {
    if (!placeId) {
      return {
        directory: this.getDirectory(),
        placeId: null,
        cached: false,
        summaryCount: 0,
        freshSummaryCount: 0,
        staleSummaryCount: 0,
      };
    }

    const snapshot = await this.loadStructureMap(placeId);
    if (!snapshot) {
      return {
        directory: this.getDirectory(),
        placeId,
        cached: false,
        summaryCount: 0,
        freshSummaryCount: 0,
        staleSummaryCount: 0,
      };
    }

    const nodes = Object.values(snapshot.nodesByPath);
    return {
      directory: this.getDirectory(),
      placeId,
      cached: true,
      nodeCount: nodes.length,
      scriptCount: snapshot.scriptInventory.length,
      summaryCount: Object.keys(snapshot.summaryIndex).length,
      freshSummaryCount: nodes.filter((node) => node.summaryStatus === 'fresh').length,
      staleSummaryCount: nodes.filter((node) => node.summaryStatus === 'stale').length,
      updatedAt: snapshot.updatedAt,
      version: snapshot.version,
    };
  }
}
