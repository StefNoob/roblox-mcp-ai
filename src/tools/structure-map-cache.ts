import { createHash } from 'crypto';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
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

export interface PersistedScriptSourceRecord {
  instancePath: string;
  className?: string;
  name?: string;
  source: string;
  sourceHash: string;
  sourceLength: number;
  lineCount: number;
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

export interface StructureMapSnapshotWithIndexes extends PersistedStructureMapSnapshot {
  indexes: {
    bySubsystem: Record<string, string[]>;
    byService: Record<string, string[]>;
    byScriptType: Record<string, string[]>;
    byPattern: Record<string, string[]>;
    bySummaryStatus: Record<string, string[]>;
  };
}

function buildSnapshotIndexes(snapshot: PersistedStructureMapSnapshot): StructureMapSnapshotWithIndexes {
  const bySubsystem: Record<string, string[]> = {};
  const byService: Record<string, string[]> = {};
  const byScriptType: Record<string, string[]> = {};
  const byPattern: Record<string, string[]> = {};
  const bySummaryStatus: Record<string, string[]> = {};

  for (const path of snapshot.scriptInventory) {
    const node = snapshot.nodesByPath[path];
    const summary = snapshot.summaryIndex[path];

    // By subsystem
    const subsystem = node.subsystem || summary?.subsystem;
    if (subsystem) {
      if (!bySubsystem[subsystem]) bySubsystem[subsystem] = [];
      bySubsystem[subsystem].push(path);
    }

    // By script type
    if (node.scriptType) {
      if (!byScriptType[node.scriptType]) byScriptType[node.scriptType] = [];
      byScriptType[node.scriptType].push(path);
    }

    // By summary status
    const status = node.summaryStatus || 'unknown';
    if (!bySummaryStatus[status]) bySummaryStatus[status] = [];
    bySummaryStatus[status].push(path);

    // By services
    if (summary?.servicesUsed) {
      for (const service of summary.servicesUsed) {
        if (!byService[service]) byService[service] = [];
        byService[service].push(path);
      }
    }

    // By patterns (from enhanced summary)
    if ((summary as any)?.patterns) {
      for (const pattern of (summary as any).patterns) {
        if (!byPattern[pattern]) byPattern[pattern] = [];
        byPattern[pattern].push(path);
      }
    }
  }

  return {
    ...snapshot,
    indexes: {
      bySubsystem,
      byService,
      byScriptType,
      byPattern,
      bySummaryStatus,
    },
  };
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

export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export class StructureMapCache {
  private rootDir: string;
  private relativeDir: string;
  private sourceRelativeDir: string;

  constructor(
    rootDir: string,
    relativeDir: string = path.join('.studio-cli', 'cache', 'structure-map'),
    sourceRelativeDir: string = path.join('.studio-cli', 'cache', 'source'),
  ) {
    this.rootDir = rootDir;
    this.relativeDir = relativeDir;
    this.sourceRelativeDir = sourceRelativeDir;
  }

  getDirectory() {
    return path.join(this.rootDir, this.relativeDir);
  }

  getSnapshotPath(placeId: number) {
    return path.join(this.getDirectory(), `${placeId}.json`);
  }

  getSourceDirectory() {
    return path.join(this.rootDir, this.sourceRelativeDir);
  }

  getSourceCachePath(instancePath: string) {
    const safeName = instancePath
      .replace(/[^a-z0-9._-]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'script';
    const pathHash = createHash('sha1').update(instancePath, 'utf8').digest('hex').slice(0, 16);
    return path.join(this.getSourceDirectory(), `${safeName}-${pathHash}.json`);
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

  async saveScriptSource(record: PersistedScriptSourceRecord) {
    await mkdir(this.getSourceDirectory(), { recursive: true });
    await writeFile(this.getSourceCachePath(record.instancePath), JSON.stringify(record, null, 2), 'utf8');
  }

  async loadScriptSource(instancePath: string): Promise<PersistedScriptSourceRecord | null> {
    try {
      const raw = await readFile(this.getSourceCachePath(instancePath), 'utf8');
      return JSON.parse(raw) as PersistedScriptSourceRecord;
    } catch {
      return null;
    }
  }

  private async getSourceCacheCount() {
    try {
      const entries = await readdir(this.getSourceDirectory(), { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  async getLatestCachedPlaceId() {
    try {
      const entries = await readdir(this.getDirectory(), { withFileTypes: true });
      const placeIds = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => Number.parseInt(entry.name.replace(/\.json$/i, ''), 10))
        .filter((value) => Number.isFinite(value));
      if (placeIds.length === 0) {
        return null;
      }
      return placeIds.sort((a, b) => b - a)[0];
    } catch {
      return null;
    }
  }

  async getCacheStats(placeId?: number) {
    const sourceCount = await this.getSourceCacheCount();
    if (!placeId) {
      return {
        directory: this.getDirectory(),
        sourceDirectory: this.getSourceDirectory(),
        placeId: null,
        cached: false,
        summaryCount: 0,
        freshSummaryCount: 0,
        staleSummaryCount: 0,
        sourceCount,
      };
    }

    const snapshot = await this.loadStructureMap(placeId);
    if (!snapshot) {
      return {
        directory: this.getDirectory(),
        sourceDirectory: this.getSourceDirectory(),
        placeId,
        cached: false,
        summaryCount: 0,
        freshSummaryCount: 0,
        staleSummaryCount: 0,
        sourceCount,
      };
    }

    const nodes = Object.values(snapshot.nodesByPath);
    return {
      directory: this.getDirectory(),
      sourceDirectory: this.getSourceDirectory(),
      placeId,
      cached: true,
      nodeCount: nodes.length,
      scriptCount: snapshot.scriptInventory.length,
      summaryCount: Object.keys(snapshot.summaryIndex).length,
      freshSummaryCount: nodes.filter((node) => node.summaryStatus === 'fresh').length,
      staleSummaryCount: nodes.filter((node) => node.summaryStatus === 'stale').length,
      sourceCount,
      updatedAt: snapshot.updatedAt,
      version: snapshot.version,
    };
  }
}
