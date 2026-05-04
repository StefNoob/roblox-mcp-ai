import { StudioHttpClient } from './studio-client.js';
import { BridgeService } from '../bridge-service.js';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  type PersistedStructureMapSnapshot,
  type PersistedScriptSourceRecord,
  type ScriptSummaryRecord,
  type StructureMapMode,
  type StructureMapNodeRecord,
  StructureMapCache,
  fnv1a32,
  mergeSummaryIntoSnapshot,
} from './structure-map-cache.js';
import { summarizeScriptSource } from './script-summary.js';
import {
  analyzeArchitectureSnapshot,
  analyzeScriptQuality,
} from './analysis-tools.js';
import {
  parseLuauDiagnostics,
  replaceLuauFunctionBlock,
  summarizePerformanceSamples,
} from './roi-tools.js';
import {
  type WriteJobOptions,
  type WriteOrchestratorConfigPatch,
  WriteOrchestrator,
} from './write-orchestrator.js';
import {
  type UIGenerationRequest,
  type UIGenerationResult,
  type UIPreviewData,
  createDefaultScalingConfig,
} from './schemas/ui-generation.js';
import { parseUIReference } from './ui-reference-parser.js';

type ScriptEditReplaceOperation = {
  op: 'replace';
  startLine: number;
  endLine: number;
  newContent: string;
};

type ScriptEditInsertOperation = {
  op: 'insert';
  afterLine: number;
  newContent: string;
};

type ScriptEditDeleteOperation = {
  op: 'delete';
  startLine: number;
  endLine: number;
};

type ScriptEditOperation = ScriptEditReplaceOperation | ScriptEditInsertOperation | ScriptEditDeleteOperation;
type ScriptSnapshotRecord = {
  id: string;
  instancePath: string;
  label: string;
  source: string;
  sourceHash: string;
  createdAt: number;
  sourceLength: number;
};
type WriteEnqueueOptions = Omit<WriteJobOptions, 'priority'>;
type DriftSourceAnalysis = {
  rawHash: string;
  rawLength: number;
  lineCount: number;
  normalizedHash: string;
  normalizedLength: number;
  strippedBom: boolean;
  hadCarriageReturns: boolean;
  trailingWhitespaceLines: number;
  trailingWhitespaceChars: number;
  terminalNewlineCount: number;
};
type ScriptUploadSession = {
  id: string;
  instancePath: string;
  expectedHash?: string;
  mode: 'set' | 'apply_and_verify';
  chunks: string[];
  createdAt: number;
  updatedAt: number;
};
type StructureMapQueryFilters = {
  pathPrefix?: string;
  className?: string;
  hasSource?: boolean;
  scriptType?: string;
  subsystem?: string;
  nameQuery?: string;
  limit?: number;
};
type ScriptSourceMetadata = {
  instancePath: string;
  className: string;
  name: string;
  sourceLength: number;
  lineCount: number;
  sourceHash: string;
};
type InstanceSnapshotTransferRecord = {
  id: string;
  createdAt: number;
  sourceInstancePath: string;
  snapshot: any;
  stats?: {
    nodeCount?: number;
    serializedSizeBytes?: number;
    includeScripts?: boolean;
    maxDepth?: number;
  };
  warnings: string[];
};
type DebugLogStreamCursor = {
  id: string;
  type: string;
  createdAt: number;
  updatedAt: number;
  lastTimestamp?: number;
  seenKeys: string[];
};

export class RobloxStudioTools {
  private bridge: BridgeService;
  private client: StudioHttpClient;
  private static readonly DIRECT_WRITE_THRESHOLD = 100_000;
  private static readonly DEFAULT_UPLOAD_CHUNK_SIZE = 8192;
  private static readonly SCRIPT_READ_CHUNK_SIZE = 1000;
  private fastEndpointSupport: 'unknown' | 'yes' | 'no' = 'unknown';
  private scriptMetadataSupport: 'unknown' | 'yes' | 'no' = 'unknown';
  private writeOrchestrator: WriteOrchestrator;
  private scriptSnapshots: Map<string, ScriptSnapshotRecord> = new Map();
  private scriptSnapshotSeq = 0;
  private readonly maxSnapshots = 250;
  private scriptUploads: Map<string, ScriptUploadSession> = new Map();
  private scriptUploadSeq = 0;
  private readonly maxScriptUploads = 64;
  private instanceSnapshotTransfers: Map<string, InstanceSnapshotTransferRecord> = new Map();
  private instanceSnapshotSeq = 0;
  private readonly maxInstanceSnapshotTransfers = 64;
  private debugLogStreams: Map<string, DebugLogStreamCursor> = new Map();
  private debugLogStreamSeq = 0;
  private readonly maxDebugLogStreams = 64;
  private structureMapCache: StructureMapCache;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
    this.client = new StudioHttpClient(bridge);
    this.structureMapCache = new StructureMapCache(process.cwd());
    this.writeOrchestrator = new WriteOrchestrator({
      maxConcurrency: 2,
    });
  }

  private hashSource(source: string) {
    return createHash('sha256').update(source, 'utf8').digest('hex');
  }

  private hashSourceFast(source: string) {
    return fnv1a32(source);
  }

  private extractSource(response: any): string {
    if (response && typeof response.source === 'string') {
      return response.source;
    }
    return '';
  }

  private toSourceCacheRecord(
    instancePath: string,
    source: string,
    metadata?: Partial<ScriptSourceMetadata>,
  ): PersistedScriptSourceRecord {
    return {
      instancePath,
      className: metadata?.className,
      name: metadata?.name,
      source,
      sourceHash: metadata?.sourceHash || this.hashSourceFast(source),
      sourceLength: metadata?.sourceLength ?? source.length,
      lineCount: metadata?.lineCount ?? this.countLines(source),
      updatedAt: Date.now(),
    };
  }

  private isFreshSourceCache(
    cached: PersistedScriptSourceRecord | null,
    metadata: ScriptSourceMetadata,
  ) {
    return Boolean(
      cached &&
      cached.sourceHash === metadata.sourceHash &&
      cached.sourceLength === metadata.sourceLength &&
      cached.lineCount === metadata.lineCount
    );
  }

  private buildSourceResponse(instancePath: string, source: string, metadata?: Partial<ScriptSourceMetadata>) {
    const lineCount = metadata?.lineCount ?? this.countLines(source);
    return {
      instancePath,
      className: metadata?.className,
      name: metadata?.name,
      source,
      sourceLength: metadata?.sourceLength ?? source.length,
      lineCount,
      startLine: 1,
      endLine: lineCount,
      isPartial: false,
      truncated: false,
    };
  }

  private async saveSourceCache(
    instancePath: string,
    source: string,
    metadata?: Partial<ScriptSourceMetadata>,
  ) {
    await this.structureMapCache.saveScriptSource(this.toSourceCacheRecord(instancePath, source, metadata));
  }

  private compactScriptWriteResponse(response: any) {
    const base = (response && typeof response === 'object') ? { ...response } : {};
    const payload = (base as any).propertyValue;
    delete (base as any).propertyValue;

    if (typeof payload === 'string') {
      (base as any).payloadBytes = Buffer.byteLength(payload, 'utf8');
      (base as any).payloadChars = payload.length;
    }

    return base;
  }

  private asToolResult(payload: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private nextDebugLogStreamId() {
    this.debugLogStreamSeq += 1;
    return `dls_${this.debugLogStreamSeq}`;
  }

  private cleanupDebugLogStreams(maxAgeMs: number = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    const ordered = [...this.debugLogStreams.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const stream of ordered) {
      if (this.debugLogStreams.size <= this.maxDebugLogStreams && now - stream.updatedAt <= maxAgeMs) {
        continue;
      }
      this.debugLogStreams.delete(stream.id);
    }
  }

  private makeDebugLogKey(entry: any) {
    return `${entry?.timestamp ?? ''}|${entry?.messageType ?? ''}|${entry?.message ?? ''}`;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private detectLuauLspBinary() {
    const envPath = process.env.LUAU_LSP_PATH;
    if (envPath && existsSync(envPath)) {
      return envPath;
    }
    const localName = process.platform === 'win32' ? 'luau-lsp.exe' : 'luau-lsp';
    const localPath = path.resolve(process.cwd(), '.tools', 'luau-lsp', localName);
    if (existsSync(localPath)) {
      return localPath;
    }
    return 'luau-lsp';
  }

  private async runLuauDiagnosticsCommand(filePaths: string[]) {
    const binary = this.detectLuauLspBinary();
    return await new Promise<{ code: number; stdout: string; stderr: string; binary: string }>((resolve, reject) => {
      const child = spawn(binary, [
        'analyze',
        '--no-flags-enabled',
        '--platform=roblox',
        ...filePaths,
      ], {
        cwd: process.cwd(),
        shell: false,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
          binary,
        });
      });
    });
  }

  private nextUploadId() {
    this.scriptUploadSeq += 1;
    return `su_${this.scriptUploadSeq}`;
  }

  private cleanupExpiredUploads(maxAgeMs: number = 60 * 60 * 1000) {
    const now = Date.now();
    const uploads = [...this.scriptUploads.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const upload of uploads) {
      if (this.scriptUploads.size <= this.maxScriptUploads && now - upload.updatedAt <= maxAgeMs) {
        continue;
      }
      this.scriptUploads.delete(upload.id);
    }
  }

  private async writeSourceViaBridge(instancePath: string, source: string, verify: boolean = false) {
    const response = await this.client.request('/api/set-script-source', {
      instancePath,
      source,
      preferDirect: false,
    });

    if (!verify) {
      return {
        ...response,
        verified: false,
      };
    }

    const verifyResponse = await this.readFullScriptSource(instancePath);
    const currentSource = this.extractSource(verifyResponse);
    if (currentSource !== source) {
      throw new Error(`Post-write verification failed for ${instancePath} after bridge write fallback.`);
    }

    return {
      ...response,
      verified: true,
    };
  }

  private isTruncatedFullSourceResponse(response: any) {
    if (!response || typeof response !== 'object') {
      return false;
    }

    if ((response as any).truncated === true) {
      return true;
    }

    const source = this.extractSource(response);
    const sourceLength = typeof (response as any).sourceLength === 'number' ? (response as any).sourceLength : null;
    const lineCount = typeof (response as any).lineCount === 'number' ? (response as any).lineCount : null;
    const returnedEndLine = typeof (response as any).endLine === 'number' ? (response as any).endLine : null;

    return Boolean(
      sourceLength !== null && source.length < sourceLength &&
      lineCount !== null && returnedEndLine !== null && returnedEndLine < lineCount
    );
  }

  private async getScriptMetadata(instancePath: string): Promise<ScriptSourceMetadata | null> {
    if (this.scriptMetadataSupport === 'no') {
      return null;
    }

    try {
      const response = await this.client.request('/api/get-script-metadata', { instancePath });
      if (!response || typeof response !== 'object' || typeof response.sourceHash !== 'string') {
        return null;
      }

      this.scriptMetadataSupport = 'yes';
      return {
        instancePath,
        className: String((response as any).className || ''),
        name: String((response as any).name || ''),
        sourceLength: Number((response as any).sourceLength || 0),
        lineCount: Number((response as any).lineCount || 0),
        sourceHash: String((response as any).sourceHash),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Unknown endpoint: /api/get-script-metadata')) {
        this.scriptMetadataSupport = 'no';
      }
      return null;
    }
  }

  private async readScriptSourceChunks(
    instancePath: string,
    lineCount: number,
    metadata?: Partial<ScriptSourceMetadata>,
  ) {
    const chunkSize = RobloxStudioTools.SCRIPT_READ_CHUNK_SIZE;
    const requests: Promise<any>[] = [];

    for (let startLine = 1; startLine <= lineCount; startLine += chunkSize) {
      const endLine = Math.min(lineCount, startLine + chunkSize - 1);
      requests.push(this.client.request('/api/get-script-source', {
        instancePath,
        startLine,
        endLine,
        includeNumberedSource: false,
      }));
    }

    const responses = await Promise.all(requests);
    const fullSource = responses.map((chunk) => this.extractSource(chunk)).join('\n');
    await this.saveSourceCache(instancePath, fullSource, metadata);

    return {
      ...this.buildSourceResponse(instancePath, fullSource, metadata),
      reconstructedFromChunks: true,
    };
  }

  private async readFullScriptSource(instancePath: string) {
    const metadata = await this.getScriptMetadata(instancePath);
    if (metadata) {
      const cached = await this.structureMapCache.loadScriptSource(instancePath);
      if (this.isFreshSourceCache(cached, metadata)) {
        return this.buildSourceResponse(instancePath, cached!.source, metadata);
      }

      if (metadata.lineCount > RobloxStudioTools.SCRIPT_READ_CHUNK_SIZE) {
        return this.readScriptSourceChunks(instancePath, metadata.lineCount, metadata);
      }
    }

    const response = await this.client.request('/api/get-script-source', {
      instancePath,
      fullSource: true,
      includeNumberedSource: false,
    });
    if (!this.isTruncatedFullSourceResponse(response)) {
      const source = this.extractSource(response);
      await this.saveSourceCache(instancePath, source, metadata || {
        className: typeof response?.className === 'string' ? response.className : undefined,
        name: typeof response?.name === 'string' ? response.name : undefined,
        sourceLength: typeof response?.sourceLength === 'number' ? response.sourceLength : source.length,
        lineCount: typeof response?.lineCount === 'number' ? response.lineCount : this.countLines(source),
      });
      return response;
    }

    const lineCount = metadata?.lineCount
      ?? (typeof response?.lineCount === 'number' ? response.lineCount : 0);
    if (lineCount < 1) {
      throw new Error(`Plugin returned truncated source for ${instancePath} without a valid lineCount.`);
    }

    return this.readScriptSourceChunks(instancePath, lineCount, metadata || {
      className: typeof response?.className === 'string' ? response.className : undefined,
      name: typeof response?.name === 'string' ? response.name : undefined,
      sourceLength: typeof response?.sourceLength === 'number' ? response.sourceLength : undefined,
      lineCount,
    });
  }

  private normalizeSource(source: string) {
    return source.replace(/\r\n/g, '\n');
  }

  private splitSourceLines(source: string) {
    const normalized = this.normalizeAllLineEndings(source);
    const hasTrailingNewline = normalized.endsWith('\n');
    const lines = normalized.split('\n');
    if (hasTrailingNewline) {
      lines.pop();
    }
    return {
      lines,
      hasTrailingNewline,
    };
  }

  private joinSourceLines(lines: string[], hasTrailingNewline: boolean) {
    const joined = lines.join('\n');
    return hasTrailingNewline ? `${joined}\n` : joined;
  }

  private applyBatchScriptOperations(source: string, operations: ScriptEditOperation[]) {
    const { lines: initialLines, hasTrailingNewline } = this.splitSourceLines(source);
    const lines = [...initialLines];

    for (const operation of operations) {
      if (operation.op === 'replace') {
        if (operation.startLine < 1 || operation.endLine < operation.startLine || operation.endLine > lines.length) {
          throw new Error(
            `Replace operation out of range: startLine=${operation.startLine}, endLine=${operation.endLine}, lineCount=${lines.length}`
          );
        }
        const replacement = this.splitSourceLines(operation.newContent).lines;
        lines.splice(operation.startLine - 1, operation.endLine - operation.startLine + 1, ...replacement);
        continue;
      }

      if (operation.op === 'insert') {
        if (operation.afterLine < 0 || operation.afterLine > lines.length) {
          throw new Error(
            `Insert operation out of range: afterLine=${operation.afterLine}, lineCount=${lines.length}`
          );
        }
        const insertion = this.splitSourceLines(operation.newContent).lines;
        lines.splice(operation.afterLine, 0, ...insertion);
        continue;
      }

      if (operation.startLine < 1 || operation.endLine < operation.startLine || operation.endLine > lines.length) {
        throw new Error(
          `Delete operation out of range: startLine=${operation.startLine}, endLine=${operation.endLine}, lineCount=${lines.length}`
        );
      }
      lines.splice(operation.startLine - 1, operation.endLine - operation.startLine + 1);
    }

    return this.joinSourceLines(lines, hasTrailingNewline);
  }

  private stripUtf8Bom(source: string) {
    return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  }

  private normalizeAllLineEndings(source: string) {
    return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  private countLines(source: string) {
    const normalized = this.normalizeAllLineEndings(source);
    if (normalized.length === 0) {
      return 1;
    }
    return normalized.endsWith('\n')
      ? normalized.split('\n').length - 1
      : normalized.split('\n').length;
  }

  private analyzeDriftSource(source: string): DriftSourceAnalysis {
    const rawHash = this.hashSource(source);
    const rawLength = source.length;
    const lineCount = this.countLines(source);
    const strippedBomSource = this.stripUtf8Bom(source);
    const strippedBom = strippedBomSource.length !== source.length;
    const eolNormalizedSource = this.normalizeAllLineEndings(strippedBomSource);
    const hadCarriageReturns = /\r/.test(strippedBomSource);

    let trailingWhitespaceLines = 0;
    let trailingWhitespaceChars = 0;
    const trimmedLines = eolNormalizedSource.split('\n').map((line) => {
      const trimmed = line.replace(/[ \t]+$/g, '');
      if (trimmed.length !== line.length) {
        trailingWhitespaceLines += 1;
        trailingWhitespaceChars += line.length - trimmed.length;
      }
      return trimmed;
    });

    let normalizedSource = trimmedLines.join('\n');
    const trailingNewlines = normalizedSource.match(/\n+$/);
    const terminalNewlineCount = trailingNewlines ? trailingNewlines[0].length : 0;
    if (terminalNewlineCount > 0) {
      normalizedSource = normalizedSource.slice(0, -terminalNewlineCount);
    }

    return {
      rawHash,
      rawLength,
      lineCount,
      normalizedHash: this.hashSource(normalizedSource),
      normalizedLength: normalizedSource.length,
      strippedBom,
      hadCarriageReturns,
      trailingWhitespaceLines,
      trailingWhitespaceChars,
      terminalNewlineCount,
    };
  }

  private detectFormattingDifferences(local: DriftSourceAnalysis, studio: DriftSourceAnalysis) {
    const differences: string[] = [];
    if (local.strippedBom !== studio.strippedBom) {
      differences.push('bom');
    }
    if (local.hadCarriageReturns !== studio.hadCarriageReturns) {
      differences.push('line-endings');
    }
    if (
      local.trailingWhitespaceLines !== studio.trailingWhitespaceLines ||
      local.trailingWhitespaceChars !== studio.trailingWhitespaceChars
    ) {
      differences.push('trailing-whitespace');
    }
    if (local.terminalNewlineCount !== studio.terminalNewlineCount) {
      differences.push('trailing-newline');
    }
    if (differences.length === 0) {
      differences.push('formatting');
    }
    return differences;
  }

  private nextSnapshotId() {
    this.scriptSnapshotSeq += 1;
    return `ss_${this.scriptSnapshotSeq}`;
  }

  private nextInstanceSnapshotTransferId() {
    this.instanceSnapshotSeq += 1;
    return `is_${this.instanceSnapshotSeq}`;
  }

  private cleanupInstanceSnapshotTransfers(maxAgeMs: number = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    const ordered = [...this.instanceSnapshotTransfers.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const record of ordered) {
      if (this.instanceSnapshotTransfers.size <= this.maxInstanceSnapshotTransfers && now - record.createdAt <= maxAgeMs) {
        continue;
      }
      this.instanceSnapshotTransfers.delete(record.id);
    }
  }

  private pushSnapshot(instancePath: string, source: string, label?: string) {
    const normalized = this.normalizeSource(source);
    const record: ScriptSnapshotRecord = {
      id: this.nextSnapshotId(),
      instancePath,
      label: label || 'manual',
      source: normalized,
      sourceHash: this.hashSource(normalized),
      createdAt: Date.now(),
      sourceLength: normalized.length,
    };
    this.scriptSnapshots.set(record.id, record);
    if (this.scriptSnapshots.size > this.maxSnapshots) {
      const ordered = [...this.scriptSnapshots.values()].sort((a, b) => a.createdAt - b.createdAt);
      while (ordered.length > this.maxSnapshots) {
        const evict = ordered.shift();
        if (evict) {
          this.scriptSnapshots.delete(evict.id);
        }
      }
    }
    return record;
  }

  private inferResourceKeyFromLabel(label: string) {
    const idx = label.indexOf(':');
    if (idx < 0 || idx >= label.length - 1) {
      return null;
    }
    const raw = label.slice(idx + 1).trim();
    return raw.length > 0 ? raw : null;
  }

  private enqueueWrite<T>(
    label: string,
    run: () => Promise<T>,
    priority: number = 0,
    options?: WriteEnqueueOptions,
  ): Promise<T> {
    return this.writeOrchestrator.enqueue(label, run, {
      ...options,
      priority,
      resourceKey: options?.resourceKey ?? this.inferResourceKeyFromLabel(label),
    });
  }

  configureTeamOrchestrator(config: WriteOrchestratorConfigPatch) {
    return this.writeOrchestrator.configure(config);
  }

  getTeamOrchestratorConfig() {
    return this.writeOrchestrator.getConfig();
  }

  getWriteQueueStats(options?: { verbose?: boolean; maxItems?: number }) {
    const full = this.writeOrchestrator.getStats();
    const verbose = options?.verbose === true;
    const maxItems = Math.max(1, Math.min(50, options?.maxItems ?? 5));
    if (verbose) {
      return {
        ...full,
        inFlightItems: full.inFlightItems.slice(0, maxItems),
        pendingItems: full.pendingItems.slice(0, maxItems),
      };
    }
    return {
      inFlight: full.inFlight,
      pending: full.pending,
      pendingByLane: full.pendingByLane,
      maxConcurrency: full.maxConcurrency,
      defaultTeamId: full.defaultTeamId,
      laneWeights: full.laneWeights,
      teamStats: full.teamStats,
      completedWrites: full.completedWrites,
      failedWrites: full.failedWrites,
      cancelledWrites: full.cancelledWrites,
      sampledItems: {
        inFlight: full.inFlightItems.slice(0, 1),
        pending: full.pendingItems.slice(0, Math.min(2, maxItems)),
      },
    };
  }

  cancelPendingWrites(prefix?: string) {
    return this.writeOrchestrator.cancelPending((job) => !prefix || job.label.startsWith(prefix));
  }

  private async fastWriteSource(instancePath: string, source: string, verify: boolean = true) {
    if (this.fastEndpointSupport === 'no') {
      const fallback = await this.writeSourceViaBridge(instancePath, source, verify);

      return this.compactScriptWriteResponse({
        ...fallback,
        method: 'fast-fallback-bridge',
        fallback: true,
        message: 'Script source updated via set_script_source bridge fallback (plugin missing fast endpoint).',
      });
    }

    try {
      const response = await this.client.request('/api/set-script-source-fast', {
        instancePath,
        source,
        verify,
      });
      this.fastEndpointSupport = 'yes';
      return this.compactScriptWriteResponse({
        ...response,
        fallback: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Unknown endpoint: /api/set-script-source-fast')) {
        throw error;
      }
      this.fastEndpointSupport = 'no';

      // Backward-compatible fallback for older plugin versions.
      const fallback = await this.writeSourceViaBridge(instancePath, source, verify);

      return this.compactScriptWriteResponse({
        ...fallback,
        method: 'fast-fallback-bridge',
        fallback: true,
        message: 'Script source updated via set_script_source bridge fallback (plugin missing fast endpoint).',
      });
    }
  }

  private async fetchPlaceInfoRaw() {
    return this.client.request('/api/place-info', {});
  }

  private normalizeStructureNode(node: any): StructureMapNodeRecord {
    return {
      path: String(node.path),
      name: typeof node.name === 'string' ? node.name : String(node.path).split('.').at(-1),
      className: String(node.className),
      parentPath: typeof node.parentPath === 'string' ? node.parentPath : undefined,
      childPaths: Array.isArray(node.childPaths) ? node.childPaths : undefined,
      childCount: typeof node.childCount === 'number' ? node.childCount : undefined,
      hasChildren: typeof node.hasChildren === 'boolean' ? node.hasChildren : undefined,
      hasSource: typeof node.hasSource === 'boolean' ? node.hasSource : undefined,
      scriptType: typeof node.scriptType === 'string' ? node.scriptType : undefined,
      enabled: typeof node.enabled === 'boolean' ? node.enabled : undefined,
      tags: Array.isArray(node.tags) ? node.tags : undefined,
      attributeNames: Array.isArray(node.attributeNames) ? node.attributeNames : undefined,
      sourceHash: typeof node.sourceHash === 'string' ? node.sourceHash : undefined,
      summaryStatus: node.summaryStatus,
      subsystem: typeof node.subsystem === 'string' ? node.subsystem : undefined,
    };
  }

  private formatStructureNode(node: StructureMapNodeRecord, mode: StructureMapMode = 'compact') {
    const compact = {
      path: node.path,
      name: node.name,
      className: node.className,
      hasSource: Boolean(node.hasSource),
      subsystem: node.subsystem || null,
    };
    if (mode === 'compact') {
      return compact;
    }
    const standard = {
      ...compact,
      parentPath: node.parentPath || null,
      childCount: node.childCount ?? 0,
      scriptType: node.scriptType || null,
      enabled: node.enabled ?? null,
      sourceHash: node.sourceHash || null,
      summaryStatus: node.summaryStatus || null,
    };
    if (mode === 'standard') {
      return standard;
    }
    return {
      ...standard,
      childPaths: node.childPaths || [],
      tags: node.tags || [],
      attributeNames: node.attributeNames || [],
      hasChildren: node.hasChildren ?? ((node.childCount ?? 0) > 0),
    };
  }

  private filterStructureNodes(
    snapshot: PersistedStructureMapSnapshot,
    filters: StructureMapQueryFilters = {},
  ) {
    const pathPrefix = filters.pathPrefix?.toLowerCase();
    const className = filters.className?.toLowerCase();
    const scriptType = filters.scriptType?.toLowerCase();
    const subsystem = filters.subsystem?.toLowerCase();
    const nameQuery = filters.nameQuery?.toLowerCase();
    const limit = filters.limit ?? 250;
    const matches: StructureMapNodeRecord[] = [];
    for (const node of Object.values(snapshot.nodesByPath)) {
      if (pathPrefix && !node.path.toLowerCase().includes(pathPrefix)) continue;
      if (className && node.className.toLowerCase() !== className) continue;
      if (filters.hasSource !== undefined && Boolean(node.hasSource) !== filters.hasSource) continue;
      if (scriptType && (node.scriptType || '').toLowerCase() !== scriptType) continue;
      if (subsystem && (node.subsystem || '').toLowerCase() !== subsystem) continue;
      if (nameQuery && !(node.name || '').toLowerCase().includes(nameQuery)) continue;
      matches.push(node);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  private async buildScriptSummary(
    instancePath: string,
    sourceHash: string,
  ): Promise<ScriptSummaryRecord> {
    const sourceResponse = await this.readFullScriptSource(instancePath);
    const source = this.extractSource(sourceResponse);
    return summarizeScriptSource({ instancePath, source, sourceHash });
  }

  private async hydrateScriptSummaries(snapshot: PersistedStructureMapSnapshot) {
    for (const scriptPath of snapshot.scriptInventory) {
      const node = snapshot.nodesByPath[scriptPath];
      if (!node?.sourceHash) {
        continue;
      }
      const summary = snapshot.summaryIndex[scriptPath];
      if (summary && summary.sourceHash === node.sourceHash) {
        continue;
      }
      snapshot.summaryIndex[scriptPath] = await this.buildScriptSummary(scriptPath, node.sourceHash);
    }
    return mergeSummaryIntoSnapshot(snapshot);
  }

  private async refreshStructureMapSnapshot() {
    const placeInfo = await this.fetchPlaceInfoRaw();
    const placeId = Number(placeInfo?.placeId ?? 0);
    if (!placeId) {
      throw new Error('Structure map refresh failed: placeId missing from Studio.');
    }

    const existing = await this.structureMapCache.loadStructureMap(placeId);
    await this.client.request('/api/refresh-structure-map', {});
    const summary = await this.client.request('/api/structure-map-summary', {});
    const query = await this.client.request('/api/query-structure-map', { filters: {}, mode: 'verbose' });
    const inventory = await this.client.request('/api/script-inventory', { mode: 'verbose' });

    const nodes = Array.isArray(query?.nodes) ? query.nodes : [];
    const scripts = Array.isArray(inventory?.scripts) ? inventory.scripts : [];
    const snapshot: PersistedStructureMapSnapshot = {
      placeId,
      placeName: String(placeInfo?.placeName ?? summary?.placeName ?? 'Unknown Place'),
      version: Number(summary?.version ?? Date.now()),
      updatedAt: Date.now(),
      roots: Array.isArray(summary?.roots) ? summary.roots : [],
      nodesByPath: {},
      scriptInventory: [],
      summaryIndex: existing?.summaryIndex ?? {},
    };

    for (const rawNode of nodes) {
      const node = this.normalizeStructureNode(rawNode);
      snapshot.nodesByPath[node.path] = node;
    }
    for (const rawNode of scripts) {
      const node = this.normalizeStructureNode(rawNode);
      snapshot.nodesByPath[node.path] = {
        ...snapshot.nodesByPath[node.path],
        ...node,
      };
      snapshot.scriptInventory.push(node.path);
    }

    await this.hydrateScriptSummaries(snapshot);
    await this.structureMapCache.saveStructureMap(snapshot);
    return snapshot;
  }

  private async ensureStructureMapSnapshot(forceRefresh: boolean = false) {
    const placeInfo = await this.fetchPlaceInfoRaw();
    const placeId = Number(placeInfo?.placeId ?? 0);
    if (!placeId) {
      throw new Error('Structure map unavailable: Studio place information is missing.');
    }
    if (!forceRefresh) {
      const cached = await this.structureMapCache.loadStructureMap(placeId);
      if (cached) {
        return cached;
      }
    }
    return this.refreshStructureMapSnapshot();
  }

  private resolveAnalysisNodes(
    snapshot: PersistedStructureMapSnapshot,
    options: {
      instancePaths?: string[];
      subsystem?: string;
      pathPrefix?: string;
      scriptType?: string;
      limit?: number;
    } = {},
  ) {
    if (Array.isArray(options.instancePaths) && options.instancePaths.length > 0) {
      return options.instancePaths
        .map((instancePath) => snapshot.nodesByPath[instancePath])
        .filter((node): node is StructureMapNodeRecord => Boolean(node?.hasSource))
        .slice(0, options.limit ?? 25);
    }

    return this.filterStructureNodes(snapshot, {
      subsystem: options.subsystem,
      pathPrefix: options.pathPrefix,
      scriptType: options.scriptType,
      hasSource: true,
      limit: options.limit ?? 25,
    });
  }

  private async getStructureMapRuntime() {
    const latestPlaceId = await this.structureMapCache.getLatestCachedPlaceId();
    const cache = latestPlaceId
      ? await this.structureMapCache.getCacheStats(latestPlaceId)
      : await this.structureMapCache.getCacheStats();
    return {
      cache,
      summaries: {
        count: cache.summaryCount ?? 0,
        fresh: cache.freshSummaryCount ?? 0,
        stale: cache.staleSummaryCount ?? 0,
      },
    };
  }

  // File System Tools
  async getFileTree(path: string = '') {
    const response = await this.client.request('/api/file-tree', { path });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async searchFiles(query: string, searchType: string = 'name') {
    let response: any;
    if (searchType === 'name' || searchType === 'type') {
      const filters: StructureMapQueryFilters = searchType === 'name'
        ? { nameQuery: query, limit: 250 }
        : { className: query, limit: 250 };
      const snapshot = await this.ensureStructureMapSnapshot();
      const nodes = this.filterStructureNodes(snapshot, filters).map((node) => ({
        name: node.name,
        className: node.className,
        path: node.path,
        hasSource: Boolean(node.hasSource),
        subsystem: node.subsystem || null,
      }));
      response = { results: nodes, query, searchType, count: nodes.length, source: 'structure-map-cache' };
    } else {
      response = await this.client.request('/api/search-files', { query, searchType });
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Studio Context Tools
  async getPlaceInfo() {
    const response = await this.client.request('/api/place-info', {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getServices(serviceName?: string) {
    const response = await this.client.request('/api/services', { serviceName });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async searchObjects(query: string, searchType: string = 'name', propertyName?: string) {
    let response: any;
    if (searchType === 'name' || searchType === 'class') {
      const filters: StructureMapQueryFilters = searchType === 'name'
        ? { nameQuery: query, limit: 250 }
        : { className: query, limit: 250 };
      const snapshot = await this.ensureStructureMapSnapshot();
      const nodes = this.filterStructureNodes(snapshot, filters).map((node) => ({
        name: node.name,
        className: node.className,
        path: node.path,
      }));
      response = { results: nodes, query, searchType, count: nodes.length, source: 'structure-map-cache' };
    } else {
      response = await this.client.request('/api/search-objects', { 
        query, 
        searchType, 
        propertyName 
      });
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Property & Instance Tools
  async getInstanceProperties(instancePath: string, includeSource: boolean = false) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_instance_properties');
    }
    const response = await this.client.request('/api/instance-properties', { instancePath, includeSource });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getInstanceChildren(instancePath: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_instance_children');
    }
    const response = await this.client.request('/api/instance-children', { instancePath });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async searchByProperty(propertyName: string, propertyValue: string) {
    if (!propertyName || !propertyValue) {
      throw new Error('Property name and value are required for search_by_property');
    }
    const response = await this.client.request('/api/search-by-property', { 
      propertyName, 
      propertyValue 
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getClassInfo(className: string) {
    if (!className) {
      throw new Error('Class name is required for get_class_info');
    }
    const response = await this.client.request('/api/class-info', { className });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async exportInstanceSnapshot(
    instancePath: string,
    options?: {
      includeScripts?: boolean;
      maxDepth?: number;
    },
    sessionId?: string,
  ) {
    if (!instancePath) {
      throw new Error('Instance path is required for export_instance_snapshot');
    }
    const payload = {
      instancePath,
      includeScripts: options?.includeScripts !== false,
      maxDepth: options?.maxDepth,
    };
    const response = sessionId
      ? await this.client.request('/api/export-instance-snapshot', payload, { sessionId })
      : await this.client.request('/api/export-instance-snapshot', payload);

    if (!response || typeof response !== 'object' || !(response as any).snapshot) {
      throw new Error('Studio plugin returned an invalid snapshot response.');
    }

    this.cleanupInstanceSnapshotTransfers();
    const transfer: InstanceSnapshotTransferRecord = {
      id: this.nextInstanceSnapshotTransferId(),
      createdAt: Date.now(),
      sourceInstancePath: instancePath,
      snapshot: (response as any).snapshot,
      stats: (response as any).stats,
      warnings: Array.isArray((response as any).warnings) ? (response as any).warnings : [],
    };
    this.instanceSnapshotTransfers.set(transfer.id, transfer);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            transferId: transfer.id,
            sourceInstancePath: transfer.sourceInstancePath,
            createdAt: transfer.createdAt,
            stats: transfer.stats || null,
            warnings: transfer.warnings,
          }, null, 2)
        }
      ]
    };
  }

  async importInstanceSnapshot(
    transferId: string,
    targetParentPath: string,
    options?: {
      rootName?: string;
      conflictPolicy?: 'rename' | 'replace' | 'fail';
      namePrefix?: string;
      nameSuffix?: string;
      scriptReplacements?: Array<{ find: string; replace: string }>;
    },
    sessionId?: string,
  ) {
    if (!transferId) {
      throw new Error('Transfer ID is required for import_instance_snapshot');
    }
    if (!targetParentPath) {
      throw new Error('Target parent path is required for import_instance_snapshot');
    }

    const transfer = this.instanceSnapshotTransfers.get(transferId);
    if (!transfer) {
      throw new Error(`Snapshot transfer not found: ${transferId}`);
    }

    const payload = {
      targetParentPath,
      snapshot: transfer.snapshot,
      options: options || {},
    };
    const response = sessionId
      ? await this.client.request('/api/import-instance-snapshot', payload, { sessionId })
      : await this.client.request('/api/import-instance-snapshot', payload);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            transferId,
            sourceInstancePath: transfer.sourceInstancePath,
            targetParentPath,
            result: response,
          }, null, 2)
        }
      ]
    };
  }

  listInstanceSnapshotTransfers() {
    this.cleanupInstanceSnapshotTransfers();
    const transfers = [...this.instanceSnapshotTransfers.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => ({
        transferId: record.id,
        createdAt: record.createdAt,
        sourceInstancePath: record.sourceInstancePath,
        stats: record.stats || null,
        warnings: record.warnings,
      }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: transfers.length,
            transfers,
          }, null, 2)
        }
      ]
    };
  }

  deleteInstanceSnapshotTransfer(transferId: string) {
    if (!transferId) {
      throw new Error('Transfer ID is required for delete_instance_snapshot_transfer');
    }
    const deleted = this.instanceSnapshotTransfers.delete(transferId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            transferId,
            deleted,
          }, null, 2)
        }
      ]
    };
  }

  async copyInstanceSnapshot(
    sourceInstancePath: string,
    targetParentPath: string,
    options?: {
      includeScripts?: boolean;
      maxDepth?: number;
      rootName?: string;
      conflictPolicy?: 'rename' | 'replace' | 'fail';
      namePrefix?: string;
      nameSuffix?: string;
      scriptReplacements?: Array<{ find: string; replace: string }>;
      sourceSessionId?: string;
      targetSessionId?: string;
    },
  ) {
    const exported = await this.exportInstanceSnapshot(sourceInstancePath, {
      includeScripts: options?.includeScripts,
      maxDepth: options?.maxDepth,
    }, options?.sourceSessionId);
    const payload = JSON.parse(exported.content[0].text);
    const imported = await this.importInstanceSnapshot(payload.transferId, targetParentPath, {
      rootName: options?.rootName,
      conflictPolicy: options?.conflictPolicy,
      namePrefix: options?.namePrefix,
      nameSuffix: options?.nameSuffix,
      scriptReplacements: options?.scriptReplacements,
    }, options?.targetSessionId);
    const importPayload = JSON.parse(imported.content[0].text);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            transferId: payload.transferId,
            sourceInstancePath,
            targetParentPath,
            sourceSessionId: options?.sourceSessionId || null,
            targetSessionId: options?.targetSessionId || null,
            export: {
              stats: payload.stats || null,
              warnings: payload.warnings || [],
            },
            import: importPayload.result,
          }, null, 2)
        }
      ]
    };
  }

  async copyInstanceCrossSession(
    sourceSessionId: string,
    targetSessionId: string,
    sourceInstancePath: string,
    targetParentPath: string,
    options?: {
      includeScripts?: boolean;
      maxDepth?: number;
      rootName?: string;
      conflictPolicy?: 'rename' | 'replace' | 'fail';
      namePrefix?: string;
      nameSuffix?: string;
      scriptReplacements?: Array<{ find: string; replace: string }>;
    },
  ) {
    if (!sourceSessionId || !targetSessionId) {
      throw new Error('sourceSessionId and targetSessionId are required for copy_instance_cross_session');
    }
    if (!sourceInstancePath || !targetParentPath) {
      throw new Error('sourceInstancePath and targetParentPath are required for copy_instance_cross_session');
    }
    const result = await this.copyInstanceSnapshot(sourceInstancePath, targetParentPath, {
      ...options,
      sourceSessionId,
      targetSessionId,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...JSON.parse(result.content[0].text),
            mode: 'cross-session',
          }, null, 2)
        }
      ]
    };
  }

  listStudioSessions(maxAgeMs: number = 60_000) {
    const sessions = this.bridge.getStudioSessions(maxAgeMs).map((session) => ({
      ...session,
      placeId: session.placeId ?? null,
      placeName: session.placeName ?? null,
    }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: sessions.length,
            sessions,
            maxAgeMs,
          }, null, 2)
        }
      ]
    };
  }

  // Project Tools
  async getProjectStructure(path?: string, maxDepth?: number, scriptsOnly?: boolean) {
    let response: any;
    if (!path) {
      const snapshot = await this.ensureStructureMapSnapshot();
      const roots = snapshot.roots
        .map((rootPath) => snapshot.nodesByPath[rootPath])
        .filter(Boolean)
        .map((node) => ({
          name: node.name,
          className: node.className,
          path: node.path,
          childCount: node.childCount ?? 0,
          hasChildren: node.hasChildren ?? ((node.childCount ?? 0) > 0),
        }));
      response = {
        type: 'service_overview',
        services: roots,
        timestamp: Date.now() / 1000,
        note: 'Structure map cache overview',
      };
    } else {
      response = await this.client.request('/api/project-structure', { 
        path, 
        maxDepth, 
        scriptsOnly 
      });
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }


  // Property Modification Tools
  async setProperty(instancePath: string, propertyName: string, propertyValue: any) {
    if (!instancePath || !propertyName) {
      throw new Error('Instance path and property name are required for set_property');
    }
    if (propertyName === 'Source') {
      throw new Error('set_property cannot be used for the Source property. Use set_script_source or chunked script upload tools instead.');
    }
    const response = await this.client.request('/api/set-property', { 
      instancePath, 
      propertyName, 
      propertyValue 
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async massSetProperty(paths: string[], propertyName: string, propertyValue: any) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_set_property');
    }
    if (propertyName === 'Source') {
      throw new Error('mass_set_property cannot be used for the Source property. Use set_script_source or chunked script upload tools instead.');
    }
    const response = await this.client.request('/api/mass-set-property', { 
      paths, 
      propertyName, 
      propertyValue 
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async massGetProperty(paths: string[], propertyName: string) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_get_property');
    }
    const response = await this.client.request('/api/mass-get-property', { 
      paths, 
      propertyName
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Object Creation Tools
  async createObject(className: string, parent: string, name?: string) {
    if (!className || !parent) {
      throw new Error('Class name and parent are required for create_object');
    }
    const response = await this.client.request('/api/create-object', { 
      className, 
      parent, 
      name
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async createObjectWithProperties(className: string, parent: string, name?: string, properties?: Record<string, any>) {
    if (!className || !parent) {
      throw new Error('Class name and parent are required for create_object_with_properties');
    }
    const response = await this.client.request('/api/create-object', { 
      className, 
      parent, 
      name, 
      properties 
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async massCreateObjects(objects: Array<{className: string, parent: string, name?: string}>) {
    if (!objects || objects.length === 0) {
      throw new Error('Objects array is required for mass_create_objects');
    }
    const response = await this.client.request('/api/mass-create-objects', { objects });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async massCreateObjectsWithProperties(objects: Array<{className: string, parent: string, name?: string, properties?: Record<string, any>}>) {
    if (!objects || objects.length === 0) {
      throw new Error('Objects array is required for mass_create_objects_with_properties');
    }
    const response = await this.client.request('/api/mass-create-objects-with-properties', { objects });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async deleteObject(instancePath: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for delete_object');
    }
    const response = await this.client.request('/api/delete-object', { instancePath });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Smart Duplication Tools
  async smartDuplicate(
    instancePath: string, 
    count: number, 
    options?: {
      namePattern?: string; // e.g., "Button{n}" where {n} is replaced with index
      positionOffset?: [number, number, number]; // X, Y, Z offset per duplicate
      rotationOffset?: [number, number, number]; // X, Y, Z rotation offset per duplicate
      scaleOffset?: [number, number, number]; // X, Y, Z scale multiplier per duplicate
      propertyVariations?: Record<string, any[]>; // Property name to array of values
      targetParents?: string[]; // Different parent for each duplicate
    }
  ) {
    if (!instancePath || count < 1) {
      throw new Error('Instance path and count > 0 are required for smart_duplicate');
    }
    const response = await this.client.request('/api/smart-duplicate', { 
      instancePath, 
      count, 
      options 
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async massDuplicate(
    duplications: Array<{
      instancePath: string;
      count: number;
      options?: {
        namePattern?: string;
        positionOffset?: [number, number, number];
        rotationOffset?: [number, number, number];
        scaleOffset?: [number, number, number];
        propertyVariations?: Record<string, any[]>;
        targetParents?: string[];
      }
    }>
  ) {
    if (!duplications || duplications.length === 0) {
      throw new Error('Duplications array is required for mass_duplicate');
    }
    const response = await this.client.request('/api/mass-duplicate', { duplications });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Calculated Property Tools
  async setCalculatedProperty(
    paths: string[], 
    propertyName: string, 
    formula: string,
    variables?: Record<string, any>
  ) {
    if (!paths || paths.length === 0 || !propertyName || !formula) {
      throw new Error('Paths, property name, and formula are required for set_calculated_property');
    }
    const response = await this.client.request('/api/set-calculated-property', { 
      paths, 
      propertyName, 
      formula,
      variables
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Relative Property Tools
  async setRelativeProperty(
    paths: string[], 
    propertyName: string, 
    operation: 'add' | 'multiply' | 'divide' | 'subtract' | 'power',
    value: any,
    component?: 'X' | 'Y' | 'Z' | 'XScale' | 'XOffset' | 'YScale' | 'YOffset' // Vector3: X,Y,Z; UDim2: XScale, XOffset, YScale, YOffset
  ) {
    if (!paths || paths.length === 0 || !propertyName || !operation || value === undefined) {
      throw new Error('Paths, property name, operation, and value are required for set_relative_property');
    }
    const response = await this.client.request('/api/set-relative-property', { 
      paths, 
      propertyName, 
      operation,
      value,
      component
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Script Management Tools
  async getScriptSource(instancePath: string, startLine?: number, endLine?: number) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_script_source');
    }
    const response = await this.client.request('/api/get-script-source', { instancePath, startLine, endLine });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getStructureMapSummary() {
    const snapshot = await this.ensureStructureMapSnapshot();
    const cache = await this.structureMapCache.getCacheStats(snapshot.placeId);
    const payload = {
      placeId: snapshot.placeId,
      placeName: snapshot.placeName,
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
      rootCount: snapshot.roots.length,
      nodeCount: Object.keys(snapshot.nodesByPath).length,
      scriptCount: snapshot.scriptInventory.length,
      roots: snapshot.roots,
      cache,
    };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        }
      ]
    };
  }

  async queryStructureMap(filters: StructureMapQueryFilters = {}, mode: StructureMapMode = 'compact') {
    const snapshot = await this.ensureStructureMapSnapshot();
    const nodes = this.filterStructureNodes(snapshot, filters).map((node) => this.formatStructureNode(node, mode));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            placeId: snapshot.placeId,
            placeName: snapshot.placeName,
            version: snapshot.version,
            mode,
            count: nodes.length,
            nodes,
          }, null, 2),
        }
      ]
    };
  }

  async refreshStructureMap() {
    const snapshot = await this.refreshStructureMapSnapshot();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            placeId: snapshot.placeId,
            placeName: snapshot.placeName,
            version: snapshot.version,
            updatedAt: snapshot.updatedAt,
            nodeCount: Object.keys(snapshot.nodesByPath).length,
            scriptCount: snapshot.scriptInventory.length,
          }, null, 2),
        }
      ]
    };
  }

  async getScriptInventory(mode: StructureMapMode = 'compact') {
    const snapshot = await this.ensureStructureMapSnapshot();
    const scripts = snapshot.scriptInventory.map((scriptPath) => {
      const node = snapshot.nodesByPath[scriptPath];
      const summary = snapshot.summaryIndex[scriptPath];
      return {
        ...this.formatStructureNode(node, mode),
        summaryShort: summary?.summaryShort || null,
        summaryLong: mode === 'verbose' ? (summary?.summaryLong || null) : undefined,
        dependencies: mode === 'compact' ? undefined : (summary?.dependencies || []),
        servicesUsed: mode === 'compact' ? undefined : (summary?.servicesUsed || []),
        sideEffects: mode === 'verbose' ? (summary?.sideEffects || []) : undefined,
      };
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            placeId: snapshot.placeId,
            placeName: snapshot.placeName,
            version: snapshot.version,
            mode,
            count: scripts.length,
            scripts,
          }, null, 2),
        }
      ]
    };
  }

  async explainScriptCached(instancePath: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for explain_script_cached');
    }
    const snapshot = await this.ensureStructureMapSnapshot();
    const node = snapshot.nodesByPath[instancePath];
    if (!node || !node.hasSource) {
      throw new Error(`Script not found in structure map: ${instancePath}`);
    }
    const currentHash = node.sourceHash || '';
    let summary = snapshot.summaryIndex[instancePath];
    if (!summary || summary.sourceHash !== currentHash) {
      summary = await this.buildScriptSummary(instancePath, currentHash);
      snapshot.summaryIndex[instancePath] = summary;
      snapshot.nodesByPath[instancePath].summaryStatus = 'fresh';
      await this.structureMapCache.saveStructureMap(snapshot);
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            node: this.formatStructureNode(snapshot.nodesByPath[instancePath], 'verbose'),
            summary,
          }, null, 2),
        }
      ]
    };
  }

  async getSubsystemSummary(subsystem: string) {
    if (!subsystem) {
      throw new Error('Subsystem is required for get_subsystem_summary');
    }
    const snapshot = await this.ensureStructureMapSnapshot();
    const nodes = this.filterStructureNodes(snapshot, { subsystem, limit: 500 });
    const scripts = nodes.filter((node) => node.hasSource);
    const summaries = scripts.map((node) => snapshot.summaryIndex[node.path]).filter(Boolean);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            subsystem,
            placeId: snapshot.placeId,
            placeName: snapshot.placeName,
            nodeCount: nodes.length,
            scriptCount: scripts.length,
            scripts: scripts.map((node) => ({
              path: node.path,
              className: node.className,
              summaryShort: snapshot.summaryIndex[node.path]?.summaryShort || null,
            })),
            servicesUsed: [...new Set(summaries.flatMap((summary) => summary.servicesUsed || []))],
            dependencies: [...new Set(summaries.flatMap((summary) => summary.dependencies || []))],
          }, null, 2),
        }
      ]
    };
  }

  async analyzeProjectArchitecture(options: {
    subsystem?: string;
    pathPrefix?: string;
    scriptType?: string;
    limit?: number;
    includeDependencies?: boolean;
  } = {}) {
    const snapshot = await this.ensureStructureMapSnapshot();
    const nodeLimit = options.limit ?? 25;
    const candidateNodes = this.resolveAnalysisNodes(snapshot, {
      subsystem: options.subsystem,
      pathPrefix: options.pathPrefix,
      scriptType: options.scriptType,
      limit: nodeLimit,
    });

    const scopedSnapshot: PersistedStructureMapSnapshot = {
      ...snapshot,
      nodesByPath: Object.fromEntries(candidateNodes.map((node) => [node.path, snapshot.nodesByPath[node.path]])),
      scriptInventory: candidateNodes.map((node) => node.path),
      summaryIndex: Object.fromEntries(
        candidateNodes
          .map((node) => [node.path, snapshot.summaryIndex[node.path]])
          .filter((entry): entry is [string, ScriptSummaryRecord] => Boolean(entry[1])),
      ),
    };

    const report = analyzeArchitectureSnapshot(scopedSnapshot, {
      subsystem: options.subsystem,
      pathPrefix: options.pathPrefix,
      scriptType: options.scriptType,
      limit: nodeLimit,
      includeDependencies: options.includeDependencies ?? false,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            placeId: snapshot.placeId,
            placeName: snapshot.placeName,
            ...report,
          }, null, 2),
        }
      ]
    };
  }

  async analyzeCodeQuality(options: {
    instancePaths?: string[];
    subsystem?: string;
    pathPrefix?: string;
    limit?: number;
    includeSourceHints?: boolean;
  } = {}) {
    const snapshot = await this.ensureStructureMapSnapshot();
    const nodes = this.resolveAnalysisNodes(snapshot, {
      instancePaths: options.instancePaths,
      subsystem: options.subsystem,
      pathPrefix: options.pathPrefix,
      limit: options.limit ?? 10,
    });

    const scripts = [];
    for (const node of nodes) {
      const currentHash = node.sourceHash || '';
      const sourceResponse = await this.readFullScriptSource(node.path);
      const source = this.extractSource(sourceResponse);
      const summary = snapshot.summaryIndex[node.path] && snapshot.summaryIndex[node.path].sourceHash === currentHash
        ? snapshot.summaryIndex[node.path]
        : summarizeScriptSource({ instancePath: node.path, source, sourceHash: currentHash });
      const report = analyzeScriptQuality({
        path: node.path,
        className: node.className,
        scriptType: node.scriptType,
        subsystem: node.subsystem || summary.subsystem,
        summaryShort: summary.summaryShort,
        source,
        dependencies: summary.dependencies || [],
        servicesUsed: summary.servicesUsed || [],
        sideEffects: summary.sideEffects || [],
      });
      scripts.push(report);
    }

    const findings = scripts
      .flatMap((script) => script.findings)
      .map((finding) => (
        options.includeSourceHints
          ? finding
          : { ...finding, evidence: undefined }
      ));
    const severityCount = {
      high: findings.filter((finding) => finding.severity === 'high').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
    };
    const averageScore = scripts.length > 0
      ? Math.round(scripts.reduce((sum, script) => sum + script.score, 0) / scripts.length)
      : 0;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            placeId: snapshot.placeId,
            placeName: snapshot.placeName,
            filters: {
              instancePaths: options.instancePaths || [],
              subsystem: options.subsystem || null,
              pathPrefix: options.pathPrefix || null,
              limit: options.limit ?? 10,
              includeSourceHints: options.includeSourceHints ?? false,
            },
            summary: {
              scriptCount: scripts.length,
              averageScore,
              totalFindings: findings.length,
              severities: severityCount,
            },
            scripts: scripts.map((script) => ({
              ...script,
              findings: options.includeSourceHints
                ? script.findings
                : script.findings.map((finding) => ({ ...finding, evidence: undefined })),
            })),
            findings,
          }, null, 2),
        }
      ]
    };
  }

  async beginScriptSourceUpload(
    instancePath: string,
    expectedHash?: string,
    mode: 'set' | 'apply_and_verify' = 'set',
  ) {
    if (!instancePath) {
      throw new Error('Instance path is required for begin_script_source_upload');
    }

    this.cleanupExpiredUploads();
    const session: ScriptUploadSession = {
      id: this.nextUploadId(),
      instancePath,
      expectedHash,
      mode,
      chunks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.scriptUploads.set(session.id, session);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            uploadId: session.id,
            instancePath,
            mode,
            chunkSize: RobloxStudioTools.DEFAULT_UPLOAD_CHUNK_SIZE,
          }, null, 2)
        }
      ]
    };
  }

  async appendScriptSourceUploadChunk(uploadId: string, chunk: string, chunkIndex?: number) {
    if (!uploadId || typeof chunk !== 'string') {
      throw new Error('uploadId and chunk are required for append_script_source_upload_chunk');
    }

    const session = this.scriptUploads.get(uploadId);
    if (!session) {
      throw new Error(`Upload session not found: ${uploadId}`);
    }
    if (typeof chunkIndex === 'number' && chunkIndex !== session.chunks.length) {
      throw new Error(`Chunk index mismatch for ${uploadId}. Expected ${session.chunks.length} but received ${chunkIndex}.`);
    }

    session.chunks.push(chunk);
    session.updatedAt = Date.now();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            uploadId,
            chunkIndex: session.chunks.length - 1,
            totalChunks: session.chunks.length,
            accumulatedBytes: session.chunks.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0),
          }, null, 2)
        }
      ]
    };
  }

  async commitScriptSourceUpload(
    uploadId: string,
    verifyNeedle?: string,
    rollbackOnFailure: boolean = true,
    preferFast: boolean = false,
  ) {
    if (!uploadId) {
      throw new Error('uploadId is required for commit_script_source_upload');
    }

    const session = this.scriptUploads.get(uploadId);
    if (!session) {
      throw new Error(`Upload session not found: ${uploadId}`);
    }

    const source = session.chunks.join('');
    this.scriptUploads.delete(uploadId);

    if (session.mode === 'apply_and_verify') {
      return this.applyAndVerifyScriptSource(
        session.instancePath,
        source,
        session.expectedHash,
        verifyNeedle,
        rollbackOnFailure,
        preferFast,
      );
    }

    return this.setScriptSource(session.instancePath, source, session.expectedHash);
  }

  async cancelScriptSourceUpload(uploadId: string) {
    if (!uploadId) {
      throw new Error('uploadId is required for cancel_script_source_upload');
    }

    const existed = this.scriptUploads.delete(uploadId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: existed,
            uploadId,
          }, null, 2)
        }
      ]
    };
  }

  async getRuntimeState(verbose: boolean = false) {
    const structureMap = await this.getStructureMapRuntime();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            writeQueue: this.getWriteQueueStats({ verbose }),
            fastEndpointSupport: this.fastEndpointSupport,
            structureMap,
            snapshots: {
              count: this.scriptSnapshots.size,
              max: this.maxSnapshots,
            },
          }, null, 2)
        }
      ]
    };
  }

  async getDiagnostics(verbose: boolean = false) {
    const structureMap = await this.getStructureMapRuntime();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            runtime: {
              writeQueue: this.getWriteQueueStats({ verbose }),
              fastEndpointSupport: this.fastEndpointSupport,
              structureMap,
            },
            snapshots: {
              count: this.scriptSnapshots.size,
              max: this.maxSnapshots,
              latest: [...this.scriptSnapshots.values()]
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, verbose ? 10 : 3)
                .map((x) => ({
                  id: x.id,
                  instancePath: x.instancePath,
                  label: x.label,
                  sourceHash: x.sourceHash,
                  sourceLength: x.sourceLength,
                  createdAt: x.createdAt,
                })),
            },
          }, null, 2)
        }
      ]
    };
  }

  async createScriptSnapshot(instancePath: string, label?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for create_script_snapshot');
    }
    const response = await this.readFullScriptSource(instancePath);
    const source = this.extractSource(response);
    const record = this.pushSnapshot(instancePath, source, label);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            snapshotId: record.id,
            instancePath: record.instancePath,
            label: record.label,
            sourceHash: record.sourceHash,
            sourceLength: record.sourceLength,
            createdAt: record.createdAt,
          }, null, 2)
        }
      ]
    };
  }

  async listScriptSnapshots(instancePath?: string) {
    const list = [...this.scriptSnapshots.values()]
      .filter((x) => !instancePath || x.instancePath === instancePath)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => ({
        id: x.id,
        instancePath: x.instancePath,
        label: x.label,
        sourceHash: x.sourceHash,
        sourceLength: x.sourceLength,
        createdAt: x.createdAt,
      }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: list.length,
            snapshots: list,
          }, null, 2)
        }
      ]
    };
  }

  async rollbackScriptSnapshot(snapshotId: string, verify: boolean = true) {
    if (!snapshotId) {
      throw new Error('Snapshot id is required for rollback_script_snapshot');
    }
    const record = this.scriptSnapshots.get(snapshotId);
    if (!record) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const response = await this.enqueueWrite(
      `rollback_script_snapshot:${record.instancePath}`,
      async () => this.fastWriteSource(record.instancePath, record.source, verify),
      12,
    );

    const verifyResponse = await this.readFullScriptSource(record.instancePath);
    const currentSource = this.normalizeSource(this.extractSource(verifyResponse));
    const currentHash = this.hashSource(currentSource);
    const restored = currentHash === record.sourceHash;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: restored,
            snapshotId: record.id,
            instancePath: record.instancePath,
            expectedHash: record.sourceHash,
            currentHash,
            response,
          }, null, 2)
        }
      ]
    };
  }

  async applyAndVerifyScriptSource(
    instancePath: string,
    source: string,
    expectedHash?: string,
    verifyNeedle?: string,
    rollbackOnFailure: boolean = true,
    preferFast?: boolean,
  ) {
    if (!instancePath || typeof source !== 'string') {
      throw new Error('Instance path and source are required for apply_and_verify_script_source');
    }

    const beforeResponse = await this.readFullScriptSource(instancePath);
    const beforeSource = this.normalizeSource(this.extractSource(beforeResponse));
    const beforeHash = this.hashSource(beforeSource);
    if (expectedHash && expectedHash !== beforeHash) {
      throw new Error(`Expected hash mismatch for ${instancePath}. Expected ${expectedHash} but found ${beforeHash}.`);
    }

    const snapshot = this.pushSnapshot(instancePath, beforeSource, 'apply_and_verify:prewrite');
    const useFast = preferFast === true || source.length > RobloxStudioTools.DIRECT_WRITE_THRESHOLD;
    const normalizedTarget = this.normalizeSource(source);
    const targetHash = this.hashSource(normalizedTarget);

    let writeResponse: any;
    try {
      writeResponse = await this.enqueueWrite(
        `apply_and_verify:${instancePath}`,
        async () => (useFast
          ? this.fastWriteSource(instancePath, source, true)
          : this.client.request('/api/set-script-source', { instancePath, source, preferDirect: false })),
        11,
      );
    } catch (error) {
      throw new Error(`Failed to apply source for ${instancePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const afterResponse = await this.readFullScriptSource(instancePath);
    const afterSource = this.normalizeSource(this.extractSource(afterResponse));
    const afterHash = this.hashSource(afterSource);
    const matchesHash = afterHash === targetHash;
    const matchesNeedle = typeof verifyNeedle === 'string' ? afterSource.includes(verifyNeedle) : true;

    if (matchesHash && matchesNeedle) {
      await this.saveSourceCache(instancePath, afterSource);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              instancePath,
              snapshotId: snapshot.id,
              beforeHash,
              targetHash,
              afterHash,
              verifyNeedle: verifyNeedle || null,
              writeResponse: this.compactScriptWriteResponse(writeResponse),
            }, null, 2)
          }
        ]
      };
    }

    let rollbackStatus: 'skipped' | 'succeeded' | 'failed' = 'skipped';
    if (rollbackOnFailure) {
      try {
        await this.enqueueWrite(
          `apply_and_verify_rollback:${instancePath}`,
          async () => this.fastWriteSource(instancePath, beforeSource, true),
          13,
        );
        rollbackStatus = 'succeeded';
      } catch {
        rollbackStatus = 'failed';
      }
    }

    throw new Error(
      `Post-write verification failed for ${instancePath}. ` +
      `hashMatch=${matchesHash}, needleMatch=${matchesNeedle}, rollback=${rollbackStatus}, snapshotId=${snapshot.id}`
    );
  }

  async checkScriptDrift(
    mappings: Array<{ instancePath: string; localFile: string }>,
    normalizeLineEndings: boolean = true,
  ) {
    if (!Array.isArray(mappings) || mappings.length === 0) {
      throw new Error('At least one mapping is required for check_script_drift');
    }

    const results: Array<any> = [];
    for (const mapping of mappings) {
      const instancePath = mapping?.instancePath;
      const localFile = mapping?.localFile;
      if (!instancePath || !localFile) {
        results.push({
          instancePath: instancePath || null,
          localFile: localFile || null,
          status: 'invalid',
          reason: 'instancePath and localFile are required',
        });
        continue;
      }

      let localSource = '';
      try {
        localSource = await readFile(localFile, 'utf8');
      } catch (error) {
        results.push({
          instancePath,
          localFile,
          status: 'local-read-error',
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      let studioSource = '';
      try {
        const studio = await this.readFullScriptSource(instancePath);
        studioSource = this.extractSource(studio);
      } catch (error) {
        results.push({
          instancePath,
          localFile,
          status: 'studio-read-error',
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const localAnalysis = this.analyzeDriftSource(localSource);
      const studioAnalysis = this.analyzeDriftSource(studioSource);
      const compareNormalized = normalizeLineEndings;
      const localHash = compareNormalized ? localAnalysis.normalizedHash : localAnalysis.rawHash;
      const studioHash = compareNormalized ? studioAnalysis.normalizedHash : studioAnalysis.rawHash;
      const formattingOnly = compareNormalized &&
        localAnalysis.rawHash !== studioAnalysis.rawHash &&
        localAnalysis.normalizedHash === studioAnalysis.normalizedHash;

      results.push({
        instancePath,
        localFile,
        status: localHash === studioHash ? 'in-sync' : 'drift',
        comparisonMode: compareNormalized ? 'canonical-text' : 'raw',
        formattingOnly,
        formattingDifferences: formattingOnly ? this.detectFormattingDifferences(localAnalysis, studioAnalysis) : [],
        localHash,
        studioHash,
        localLength: compareNormalized ? localAnalysis.normalizedLength : localAnalysis.rawLength,
        studioLength: compareNormalized ? studioAnalysis.normalizedLength : studioAnalysis.rawLength,
        localLineCount: localAnalysis.lineCount,
        studioLineCount: studioAnalysis.lineCount,
        rawLocalHash: localAnalysis.rawHash,
        rawStudioHash: studioAnalysis.rawHash,
        rawLocalLength: localAnalysis.rawLength,
        rawStudioLength: studioAnalysis.rawLength,
        normalizedLocalHash: localAnalysis.normalizedHash,
        normalizedStudioHash: studioAnalysis.normalizedHash,
        normalizedLocalLength: localAnalysis.normalizedLength,
        normalizedStudioLength: studioAnalysis.normalizedLength,
      });
    }

    const summary = {
      total: results.length,
      inSync: results.filter((x) => x.status === 'in-sync').length,
      formattingOnly: results.filter((x) => x.formattingOnly).length,
      drift: results.filter((x) => x.status === 'drift').length,
      failures: results.filter((x) => x.status !== 'in-sync' && x.status !== 'drift').length,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ summary, results }, null, 2)
        }
      ]
    };
  }

  async lintDeprecatedApis(rootPath: string = process.cwd()) {
    const findings: Array<{ file: string; line: number; match: string; suggestion: string }> = [];
    const ignores = new Set(['node_modules', '.git', 'dist']);
    const exts = new Set(['.lua', '.luau']);
    const target = 'GetCollisionGroups';

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignores.has(entry.name)) {
            await walk(full);
          }
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!exts.has(ext)) {
          continue;
        }
        let source = '';
        try {
          source = await readFile(full, 'utf8');
        } catch {
          continue;
        }
        const lines = source.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].includes(target)) {
            findings.push({
              file: full,
              line: i + 1,
              match: target,
              suggestion: 'Use PhysicsService:GetRegisteredCollisionGroups() instead.',
            });
          }
        }
      }
    };

    await walk(rootPath);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            rootPath,
            findings,
            totalFindings: findings.length,
          }, null, 2)
        }
      ]
    };
  }

  async getScriptSnapshot(instancePath: string, startLine?: number, endLine?: number) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_script_snapshot');
    }

    const response = (!startLine && !endLine)
      ? await this.readFullScriptSource(instancePath)
      : await this.client.request('/api/get-script-source', {
          instancePath,
          startLine,
          endLine,
          fullSource: false,
          includeNumberedSource: false,
        });
    const source = this.extractSource(response);
    const snapshot = {
      ...response,
      sourceHash: this.hashSource(source),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(snapshot, null, 2)
        }
      ]
    };
  }

  async setScriptSource(instancePath: string, source: string, expectedHash?: string) {
    if (!instancePath || typeof source !== 'string') {
      throw new Error('Instance path and source code string are required for set_script_source');
    }

    let currentHash: string | null = null;
    if (expectedHash) {
      const snapshotResponse = await this.readFullScriptSource(instancePath);
      const currentSource = this.extractSource(snapshotResponse);
      currentHash = this.hashSource(currentSource);
      if (currentHash !== expectedHash) {
        throw new Error(
          `Script hash mismatch for ${instancePath}. Expected ${expectedHash} but found ${currentHash}. Reload the script and reapply your edit.`
        );
      }
    }

    const response = await this.enqueueWrite(
      `set_script_source:${instancePath}`,
      async () => {
        const useFastPath = source.length > RobloxStudioTools.DIRECT_WRITE_THRESHOLD;
        return useFastPath
          ? this.fastWriteSource(instancePath, source, true)
          : this.client.request('/api/set-script-source', {
              instancePath,
              source,
              preferDirect: false,
            });
      },
      5,
    );
    await this.saveSourceCache(instancePath, source);
    let newHash: string | null = null;
    if (expectedHash) {
      const updatedSource = await this.readFullScriptSource(instancePath);
      newHash = this.hashSource(this.extractSource(updatedSource));
    }

    const payload = {
      ...this.compactScriptWriteResponse(response),
      expectedHash: expectedHash || null,
      previousHash: currentHash,
      newHash
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2)
        }
      ]
    };
  }

  async setScriptSourceChecked(instancePath: string, source: string, expectedHash: string) {
    if (!expectedHash) {
      throw new Error('Expected hash is required for set_script_source_checked');
    }
    return this.setScriptSource(instancePath, source, expectedHash);
  }

  async setScriptSourceFast(instancePath: string, source: string, verify: boolean = true) {
    if (!instancePath || typeof source !== 'string') {
      throw new Error('Instance path and source code string are required for set_script_source_fast');
    }
    const response = await this.enqueueWrite(
      `set_script_source_fast:${instancePath}`,
      async () => this.fastWriteSource(instancePath, source, verify),
      10,
    );
    await this.saveSourceCache(instancePath, source);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async setScriptSourceFastGzip(instancePath: string, sourceGzipBase64: string, verify: boolean = true) {
    if (!instancePath || typeof sourceGzipBase64 !== 'string' || sourceGzipBase64.length === 0) {
      throw new Error('Instance path and sourceGzipBase64 are required for set_script_source_fast_gzip');
    }
    const source = gunzipSync(Buffer.from(sourceGzipBase64, 'base64')).toString('utf8');
    return this.setScriptSourceFast(instancePath, source, verify);
  }

  // Partial Script Editing Tools
  async editScriptLines(instancePath: string, startLine: number, endLine: number, newContent: string) {
    if (!instancePath || !startLine || !endLine || typeof newContent !== 'string') {
      throw new Error('Instance path, startLine, endLine, and newContent are required for edit_script_lines');
    }
    const response = await this.enqueueWrite(
      `edit_script_lines:${instancePath}`,
      async () => this.client.request('/api/edit-script-lines', { instancePath, startLine, endLine, newContent }),
      8,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async batchScriptEdits(
    instancePath: string,
    operations: ScriptEditOperation[],
    expectedHash?: string,
    rollbackOnFailure: boolean = true,
    fastMode: boolean = false
  ) {
    if (!instancePath) {
      throw new Error('Instance path is required for batch_script_edits');
    }
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error('At least one operation is required for batch_script_edits');
    }

    const needsSnapshot = Boolean(expectedHash) || rollbackOnFailure || !fastMode;
    let originalSource: string | null = null;
    let originalHash: string | null = null;

    if (needsSnapshot) {
      const snapshotResponse = await this.readFullScriptSource(instancePath);
      originalSource = this.extractSource(snapshotResponse);
      originalHash = this.hashSource(originalSource);
    }

    if (expectedHash && expectedHash !== originalHash) {
      throw new Error(
        `Script hash mismatch for ${instancePath}. Expected ${expectedHash} but found ${originalHash}.`
      );
    }

    try {
      await this.enqueueWrite(
        `batch_script_edits:${instancePath}`,
        async () => this.client.request('/api/batch-script-edits', {
          instancePath,
          operations,
          rollbackOnFailure
        }),
        9,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Unknown endpoint: /api/batch-script-edits')) {
        if (originalSource === null) {
          throw new Error('Batch edit fallback could not load the original script source.');
        }
        const nextSource = this.applyBatchScriptOperations(originalSource, operations);
        const writeResponse = await this.enqueueWrite(
          `batch_script_edits_fallback:${instancePath}`,
          async () => this.client.request('/api/set-script-source', {
            instancePath,
            source: nextSource,
            preferDirect: false,
          }),
          9,
        );

        const finalResponse = await this.readFullScriptSource(instancePath);
        const finalSource = this.extractSource(finalResponse);
        const finalHash = this.hashSource(finalSource);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                instancePath,
                operationsApplied: operations.length,
                originalHash,
                newHash: finalHash,
                fastMode,
                fallback: true,
                fallbackReason: 'plugin-missing-batch-endpoint',
                writeResponse: this.compactScriptWriteResponse(writeResponse),
              }, null, 2)
            }
          ]
        };
      }
      let rollbackSucceeded = false;
      if (rollbackOnFailure && originalSource !== null) {
        try {
          await this.client.request('/api/set-script-source', {
            instancePath,
            source: originalSource,
            preferDirect: originalSource.length > RobloxStudioTools.DIRECT_WRITE_THRESHOLD,
          });
          rollbackSucceeded = true;
        } catch {
          rollbackSucceeded = false;
        }
      }

      throw new Error(
        `Batch edit failed for ${operations.length} operations. ` +
        `Rollback ${rollbackOnFailure ? (rollbackSucceeded ? 'succeeded' : 'failed') : 'skipped'}. ` +
        `Cause: ${message}`
      );
    }

    let newHash: string | null = null;
    if (!fastMode) {
      const finalResponse = await this.readFullScriptSource(instancePath);
      newHash = this.hashSource(this.extractSource(finalResponse));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            instancePath,
            operationsApplied: operations.length,
            originalHash,
            newHash,
            fastMode
          }, null, 2)
        }
      ]
    };
  }

  async insertScriptLines(instancePath: string, afterLine: number, newContent: string) {
    if (!instancePath || typeof newContent !== 'string') {
      throw new Error('Instance path and newContent are required for insert_script_lines');
    }
    const response = await this.enqueueWrite(
      `insert_script_lines:${instancePath}`,
      async () => this.client.request('/api/insert-script-lines', { instancePath, afterLine: afterLine || 0, newContent }),
      8,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async deleteScriptLines(instancePath: string, startLine: number, endLine: number) {
    if (!instancePath || !startLine || !endLine) {
      throw new Error('Instance path, startLine, and endLine are required for delete_script_lines');
    }
    const response = await this.enqueueWrite(
      `delete_script_lines:${instancePath}`,
      async () => this.client.request('/api/delete-script-lines', { instancePath, startLine, endLine }),
      8,
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getLuauDiagnostics(options: {
    instancePaths?: string[];
    includeSourceHints?: boolean;
  } = {}) {
    const instancePaths = Array.isArray(options.instancePaths) ? options.instancePaths.filter(Boolean) : [];
    if (instancePaths.length === 0) {
      throw new Error('instancePaths is required for get_luau_diagnostics');
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), 'roblox-mcp-luau-'));
    const fileToInstancePath = new Map<string, string>();

    try {
      let index = 0;
      for (const instancePath of instancePaths) {
        const sourceResponse = await this.readFullScriptSource(instancePath);
        const source = this.extractSource(sourceResponse);
        const filePath = path.join(tempDir, `script_${index + 1}.luau`);
        index += 1;
        await writeFile(filePath, source, 'utf8');
        fileToInstancePath.set(filePath, instancePath);
      }

      try {
        const result = await this.runLuauDiagnosticsCommand([...fileToInstancePath.keys()]);
        const diagnostics = parseLuauDiagnostics(`${result.stdout}\n${result.stderr}`)
          .map((entry) => ({
            ...entry,
            instancePath: fileToInstancePath.get(entry.filePath) || entry.filePath,
          }));
        const visibleDiagnostics = options.includeSourceHints
          ? diagnostics
          : diagnostics.map(({ raw, ...rest }) => rest);
        const severities = {
          error: diagnostics.filter((entry) => entry.severity === 'error').length,
          warning: diagnostics.filter((entry) => entry.severity === 'warning').length,
          info: diagnostics.filter((entry) => entry.severity === 'info').length,
        };
        return this.asToolResult({
          tooling: {
            available: true,
            binary: result.binary,
            exitCode: result.code,
          },
          summary: {
            scriptCount: instancePaths.length,
            totalFindings: diagnostics.length,
            severities,
          },
          diagnostics: visibleDiagnostics,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT|not found/i.test(message)) {
          return this.asToolResult({
            tooling: {
              available: false,
              reason: 'luau-lsp not installed',
              installHint: 'Run `npm run luau:install` or set `LUAU_LSP_PATH`.',
            },
            summary: {
              scriptCount: instancePaths.length,
              totalFindings: 0,
              severities: { error: 0, warning: 0, info: 0 },
            },
            diagnostics: [],
          });
        }
        throw error;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async replaceScriptFunction(
    instancePath: string,
    functionName: string,
    newFunctionContent: string,
    expectedHash?: string,
  ) {
    if (!instancePath || !functionName || !newFunctionContent) {
      throw new Error('instancePath, functionName, and newFunctionContent are required for replace_script_function');
    }

    const sourceResponse = await this.readFullScriptSource(instancePath);
    const source = this.extractSource(sourceResponse);
    const originalHash = this.hashSource(source);

    if (expectedHash && expectedHash !== originalHash) {
      throw new Error(
        `Script hash mismatch for ${instancePath}. Expected ${expectedHash} but found ${originalHash}.`,
      );
    }

    const replacement = replaceLuauFunctionBlock(source, functionName, newFunctionContent);
    const writeResponse = await this.enqueueWrite(
      `replace_script_function:${instancePath}`,
      async () => this.client.request('/api/set-script-source', {
        instancePath,
        source: replacement.source,
        preferDirect: false,
      }),
      9,
    );

    return this.asToolResult({
      success: true,
      instancePath,
      functionName,
      originalHash,
      newHash: this.hashSource(replacement.source),
      startLine: replacement.startLine,
      endLine: replacement.endLine,
      writeResponse: this.compactScriptWriteResponse(writeResponse),
    });
  }

  // Attribute Tools
  async getAttribute(instancePath: string, attributeName: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for get_attribute');
    }
    const response = await this.client.request('/api/get-attribute', { instancePath, attributeName });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async setAttribute(instancePath: string, attributeName: string, attributeValue: any, valueType?: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for set_attribute');
    }
    const response = await this.client.request('/api/set-attribute', { instancePath, attributeName, attributeValue, valueType });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getAttributes(instancePath: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_attributes');
    }
    const response = await this.client.request('/api/get-attributes', { instancePath });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async deleteAttribute(instancePath: string, attributeName: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for delete_attribute');
    }
    const response = await this.client.request('/api/delete-attribute', { instancePath, attributeName });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  // Tag Tools (CollectionService)
  async getTags(instancePath: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_tags');
    }
    const response = await this.client.request('/api/get-tags', { instancePath });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async addTag(instancePath: string, tagName: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for add_tag');
    }
    const response = await this.client.request('/api/add-tag', { instancePath, tagName });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async removeTag(instancePath: string, tagName: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for remove_tag');
    }
    const response = await this.client.request('/api/remove-tag', { instancePath, tagName });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getTagged(tagName: string) {
    if (!tagName) {
      throw new Error('Tag name is required for get_tagged');
    }
    const response = await this.client.request('/api/get-tagged', { tagName });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getSelection() {
    const response = await this.client.request('/api/get-selection', {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async executeLuau(code: string) {
    if (!code) {
      throw new Error('Code is required for execute_luau');
    }
    const response = await this.client.request('/api/execute-luau', { code });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async startPlaytest(mode: string) {
    if (mode !== 'play' && mode !== 'run') {
      throw new Error('mode must be "play" or "run"');
    }
    const response = await this.client.request('/api/start-playtest', { mode });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async stopPlaytest() {
    const response = await this.client.request('/api/stop-playtest', {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getPlaytestOutput() {
    const response = await this.client.request('/api/get-playtest-output', {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async aiControlPlayer(action: string, duration: number = 0.1, speed: number = 1.0) {
    if (!action) {
      throw new Error('action is required for ai_control_player');
    }
    const validActions = ['move_forward', 'move_backward', 'move_left', 'move_right', 'jump', 'crouch', 'run', 'walk', 'look_up', 'look_down', 'look_left', 'look_right', 'stop'];
    if (!validActions.includes(action)) {
      throw new Error(`Invalid action. Must be one of: ${validActions.join(', ')}`);
    }
    const response = await this.client.request('/api/ai-control-player', { action, duration, speed });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async aiGetPlayerState(includeNearby: boolean = true, nearbyRadius: number = 50) {
    const response = await this.client.request('/api/ai-get-player-state', { includeNearby, nearbyRadius });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async aiInteractWithObject(objectPath: string, action: string, playerIndex: number = 1) {
    if (!objectPath || !action) {
      throw new Error('objectPath and action are required for ai_interact_with_object');
    }
    const validActions = ['click', 'touch', 'activate', 'proximity', 'hover'];
    if (!validActions.includes(action)) {
      throw new Error(`Invalid action. Must be one of: ${validActions.join(', ')}`);
    }
    const response = await this.client.request('/api/ai-interact-with-object', { objectPath, action, playerIndex });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async aiTeleportPlayer(position: { x: number; y: number; z: number }, rotation?: { x: number; y: number; z: number }, playerIndex: number = 1) {
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') {
      throw new Error('Valid position with x, y, z is required for ai_teleport_player');
    }
    const response = await this.client.request('/api/ai-teleport-player', { position, rotation, playerIndex });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getGameState(scope: string = 'all', maxResults: number = 50) {
    const validScopes = ['all', 'players', 'npcs', 'projectiles', 'physics'];
    if (!validScopes.includes(scope)) {
      throw new Error(`Invalid scope. Must be one of: ${validScopes.join(', ')}`);
    }
    const response = await this.client.request('/api/get-game-state', { scope, maxResults });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async captureDebugLogs(type: string = 'all', maxLines: number = 100, sinceTimestamp?: number) {
    const validTypes = ['all', 'errors', 'warnings', 'print', 'custom'];
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }
    const response = await this.client.request('/api/capture-debug-logs', { type, maxLines, sinceTimestamp });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async openDebugLogStream(type: string = 'all') {
    const validTypes = ['all', 'errors', 'warnings', 'print', 'custom'];
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }
    this.cleanupDebugLogStreams();
    const stream: DebugLogStreamCursor = {
      id: this.nextDebugLogStreamId(),
      type,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      seenKeys: [],
    };
    this.debugLogStreams.set(stream.id, stream);
    return this.asToolResult({
      cursorId: stream.id,
      type,
      createdAt: stream.createdAt,
    });
  }

  async pollDebugLogStream(cursorId: string, maxLines: number = 100) {
    if (!cursorId) {
      throw new Error('cursorId is required for poll_debug_log_stream');
    }
    const stream = this.debugLogStreams.get(cursorId);
    if (!stream) {
      throw new Error(`Unknown debug log cursor: ${cursorId}`);
    }
    const response = await this.client.request('/api/capture-debug-logs', {
      type: stream.type,
      maxLines,
      sinceTimestamp: stream.lastTimestamp,
    });
    const logs = Array.isArray(response?.logs) ? response.logs : [];
    const seenKeys = new Set(stream.seenKeys);
    const freshLogs = logs.filter((entry: any) => {
      const key = this.makeDebugLogKey(entry);
      if (seenKeys.has(key)) {
        return false;
      }
      seenKeys.add(key);
      return true;
    });
    if (freshLogs.length > 0) {
      const last = freshLogs[freshLogs.length - 1];
      if (typeof last?.timestamp === 'number') {
        stream.lastTimestamp = last.timestamp;
      }
    }
    stream.seenKeys = [...seenKeys].slice(-200);
    stream.updatedAt = Date.now();
    return this.asToolResult({
      cursorId: stream.id,
      type: stream.type,
      count: freshLogs.length,
      logs: freshLogs,
      lastTimestamp: stream.lastTimestamp ?? null,
    });
  }

  async closeDebugLogStream(cursorId: string) {
    if (!cursorId) {
      throw new Error('cursorId is required for close_debug_log_stream');
    }
    const existed = this.debugLogStreams.delete(cursorId);
    return this.asToolResult({
      success: existed,
      cursorId,
    });
  }

  async getRuntimeErrors(clearAfter: boolean = false) {
    const response = await this.client.request('/api/get-runtime-errors', { clearAfter });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async executeTestSequence(steps: Array<Record<string, any>>, stopOnError: boolean = true) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('steps array is required for execute_test_sequence');
    }
    const response = await this.client.request('/api/execute-test-sequence', { steps, stopOnError });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async watchPropertyChanges(instancePath: string, properties: string[], duration: number = 30) {
    if (!instancePath || !Array.isArray(properties) || properties.length === 0) {
      throw new Error('instancePath and properties array are required for watch_property_changes');
    }
    const response = await this.client.request('/api/watch-property-changes', { instancePath, properties, duration });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getPerformanceMetrics(category: string = 'all') {
    const validCategories = ['all', 'fps', 'memory', 'network', 'physics', 'instances'];
    if (!validCategories.includes(category)) {
      throw new Error(`Invalid category. Must be one of: ${validCategories.join(', ')}`);
    }
    const response = await this.client.request('/api/get-performance-metrics', { category });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async capturePerformanceSnapshot(category: string = 'all', sampleCount: number = 3, intervalMs: number = 250) {
    const validCategories = ['all', 'fps', 'memory', 'network', 'physics', 'instances'];
    if (!validCategories.includes(category)) {
      throw new Error(`Invalid category. Must be one of: ${validCategories.join(', ')}`);
    }
    const safeSampleCount = Math.max(1, Math.min(20, Math.trunc(sampleCount || 1)));
    const safeIntervalMs = Math.max(0, Math.min(5000, Math.trunc(intervalMs || 0)));
    const samples: Record<string, unknown>[] = [];

    for (let i = 0; i < safeSampleCount; i += 1) {
      const sample = await this.client.request('/api/get-performance-metrics', { category });
      samples.push(sample);
      if (i < safeSampleCount - 1 && safeIntervalMs > 0) {
        await this.sleep(safeIntervalMs);
      }
    }

    return this.asToolResult({
      category,
      sampleCount: safeSampleCount,
      intervalMs: safeIntervalMs,
      samples,
      summary: summarizePerformanceSamples(samples),
    });
  }

  async inspectTerrain(region?: Record<string, number>, includeNavmesh: boolean = false) {
    const response = await this.client.request('/api/inspect-terrain', { region, includeNavmesh });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async getNetworkStats(includePlayers: boolean = false) {
    const response = await this.client.request('/api/get-network-stats', { includePlayers });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async simulateInput(inputType: string, target?: string, position?: { x: number; y: number }, keyCode?: string) {
    if (!inputType) {
      throw new Error('inputType is required for simulate_input');
    }
    const validTypes = ['keypress', 'keydown', 'keyup', 'mouse_click', 'mouse_move', 'mouse_down', 'mouse_up', 'touch_tap', 'touch_drag'];
    if (!validTypes.includes(inputType)) {
      throw new Error(`Invalid inputType. Must be one of: ${validTypes.join(', ')}`);
    }
    const response = await this.client.request('/api/simulate-input', { inputType, target, position, keyCode });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response, null, 2)
        }
      ]
    };
  }

  async parseUIReference(imageData: string, options?: {
    detectText?: boolean;
    detectButtons?: boolean;
    minElementSize?: number;
    colorClusterCount?: number;
  }) {
    if (!imageData) {
      throw new Error('imageData is required for parse_ui_reference');
    }
    const result = await parseUIReference(imageData, options);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  async parseAndGenerateUI(imageData: string, options?: {
    detectText?: boolean;
    detectButtons?: boolean;
    minElementSize?: number;
    colorClusterCount?: number;
    scalingConfig?: any;
  }): Promise<{ parseResult: any; generationResult: UIGenerationResult }> {
    if (!imageData) {
      throw new Error('imageData is required for parse_and_generate_ui');
    }
    const parseResult = await parseUIReference(imageData, options);

    const uiContainer = this.convertParseResultToUIContainer(parseResult);
    const scalingConfig = options?.scalingConfig || createDefaultScalingConfig();

    const generationResult = await this.generateUI({
      uiContainer,
      scalingConfig,
      metadata: {
        sourceImageUrl: 'parsed',
        parserVersion: '1.0.0',
        generationTimestamp: Date.now(),
      },
    });

    return { parseResult, generationResult };
  }

  private convertParseResultToUIContainer(parseResult: any): any {
    const { hierarchy, colorPalette, metadata } = parseResult;

    function mapColorToRGB(hex: string): { r: number; g: number; b: number } {
      const cleanHex = hex.replace('#', '');
      return {
        r: parseInt(cleanHex.substring(0, 2), 16),
        g: parseInt(cleanHex.substring(2, 4), 16),
        b: parseInt(cleanHex.substring(4, 6), 16),
      };
    }

    function convertNode(node: any, parentId?: string): any[] {
      const elements: any[] = [];

      const classMap: Record<string, string> = {
        button: 'TextButton',
        text: 'TextLabel',
        image: 'ImageLabel',
        container: 'Frame',
        input: 'TextBox',
        icon: 'ImageLabel',
      };

      const className = classMap[node.type] || 'Frame';
      const colorRole = node.attributes?.colorRole;
      const bgColor = colorRole
        ? colorPalette.find((c: any) => c.role === colorRole) || colorPalette[0]
        : colorPalette[0];

      const element: any = {
        id: node.id,
        type: className,
        name: node.name,
        position: {
          type: 'absolute',
          x: Math.round(node.bounds.x),
          y: Math.round(node.bounds.y),
        },
        size: {
          type: 'absolute',
          width: Math.round(node.bounds.width),
          height: Math.round(node.bounds.height),
        },
        backgroundColor: bgColor ? mapColorToRGB(bgColor.hex) : { r: 50, g: 50, b: 50 },
        zIndex: node.zIndex || 1,
      };

      if (parentId) {
        element.parentId = parentId;
      }

      if (node.type === 'text' && node.attributes?.text) {
        element.content = { text: node.attributes.text };
        element.textStyle = {
          font: 'GothamMedium',
          textSize: 14,
          textColor: { r: 255, g: 255, b: 255 },
          textXAlignment: 'Center',
          textYAlignment: 'Center',
        };
      }

      if (node.type === 'button') {
        element.buttonConfig = {
          hoverColor: { r: 40, g: 180, b: 130 },
          clickColor: { r: 35, g: 160, b: 110 },
        };
        element.corner = { radius: 8 };
      }

      elements.push(element);

      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          elements.push(...convertNode(child, node.id));
        }
      }

      return elements;
    }

    const elements = convertNode(hierarchy);

    return {
      id: 'root',
      type: 'ScreenGui',
      name: 'GeneratedUI',
      displayOrder: 0,
      enabled: true,
      elements,
    };
  }

  async generateUI(request: UIGenerationRequest): Promise<UIGenerationResult> {
    if (!request?.uiContainer || !Array.isArray(request.uiContainer.elements)) {
      throw new Error('uiContainer with elements array is required for generate_ui');
    }
    const response = await this.client.request('/api/generate-ui', {
      uiContainer: request.uiContainer,
      scalingConfig: request.scalingConfig || createDefaultScalingConfig(),
      metadata: request.metadata || {},
    });
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid response from Studio plugin for generate_ui');
    }
    return {
      success: Boolean(response.success),
      rootInstancePath: String(response.rootInstancePath || ''),
      createdInstances: Array.isArray(response.createdInstances) ? response.createdInstances : [],
      errors: Array.isArray(response.errors) ? response.errors : undefined,
      warnings: Array.isArray(response.warnings) ? response.warnings : undefined,
    };
  }

  async previewUI(request: UIGenerationRequest): Promise<UIPreviewData> {
    if (!request?.uiContainer || !Array.isArray(request.uiContainer.elements)) {
      throw new Error('uiContainer with elements array is required for preview_ui');
    }
    const container = request.uiContainer;
    const elementCount = this.countUIElements(container.elements);
    const animationsCount = this.countUIAnimations(container.elements);
    const estimatedComplexity = this.estimateUIComplexity(elementCount, animationsCount, container.elements);
    return {
      containerJson: JSON.stringify(container, null, 2),
      elementCount,
      estimatedComplexity,
      animationsCount,
    };
  }

  private countUIElements(elements: any[]): number {
    let count = 0;
    for (const el of elements) {
      count += 1;
      if (el.elements) {
        count += this.countUIElements(el.elements);
      }
    }
    return count;
  }

  private countUIAnimations(elements: any[]): number {
    let count = 0;
    for (const el of elements) {
      if (el.animations) {
        count += el.animations.length;
      }
      if (el.elements) {
        count += this.countUIAnimations(el.elements);
      }
    }
    return count;
  }

  private estimateUIComplexity(elementCount: number, animationsCount: number, elements: any[]): 'simple' | 'medium' | 'complex' {
    let maxNesting = 0;
    for (const el of elements) {
      const nesting = this.getUINestingDepth(el);
      maxNesting = Math.max(maxNesting, nesting);
    }
    const complexityScore = elementCount + animationsCount * 2 + maxNesting * 3;
    if (complexityScore < 20) return 'simple';
    if (complexityScore < 50) return 'medium';
    return 'complex';
  }

  private getUINestingDepth(element: any, depth: number = 0): number {
    let maxChildDepth = depth;
    if (element.elements) {
      for (const child of element.elements) {
        maxChildDepth = Math.max(maxChildDepth, this.getUINestingDepth(child, depth + 1));
      }
    }
    return maxChildDepth;
  }
}
