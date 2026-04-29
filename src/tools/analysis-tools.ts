import type {
  PersistedStructureMapSnapshot,
  ScriptSummaryRecord,
  StructureMapNodeRecord,
} from './structure-map-cache.js';

export type AnalysisSeverity = 'low' | 'medium' | 'high';

export interface ArchitectureAnalysisFilters {
  subsystem?: string;
  pathPrefix?: string;
  scriptType?: string;
  limit?: number;
  includeDependencies?: boolean;
}

export interface ArchitectureRisk {
  category: string;
  severity: AnalysisSeverity;
  path: string;
  reason: string;
}

export interface ArchitectureReport {
  filters: Required<Pick<ArchitectureAnalysisFilters, 'includeDependencies'>> & Omit<ArchitectureAnalysisFilters, 'includeDependencies'>;
  summary: {
    scriptCount: number;
    subsystemCount: number;
    entrypointCount: number;
    hotspotCount: number;
  };
  subsystems: Array<{
    subsystem: string;
    scriptCount: number;
    servicesUsed: string[];
    dependencies: string[];
  }>;
  scripts: Array<{
    path: string;
    className: string;
    scriptType: string | null;
    subsystem: string | null;
    summaryShort: string | null;
    dependencyCount: number;
    serviceCount: number;
    sideEffectCount: number;
  }>;
  hotspots: Array<{
    path: string;
    subsystem: string | null;
    score: number;
    dependencyCount: number;
    serviceCount: number;
    sideEffectCount: number;
    summaryShort: string | null;
  }>;
  entrypoints: Array<{
    path: string;
    scriptType: string | null;
    reason: string;
  }>;
  risks: ArchitectureRisk[];
}

export interface ScriptQualityInput {
  path: string;
  className: string;
  scriptType?: string;
  subsystem?: string;
  summaryShort?: string | null;
  source: string;
  dependencies: string[];
  servicesUsed: string[];
  sideEffects: string[];
}

export interface QualityFinding {
  scriptPath: string;
  severity: AnalysisSeverity;
  category: string;
  title: string;
  detail: string;
  suggestion: string;
  evidence?: string;
}

export interface ScriptQualityReport {
  path: string;
  className: string;
  scriptType: string | null;
  subsystem: string | null;
  summaryShort: string | null;
  score: number;
  riskLevel: 'low' | 'moderate' | 'high';
  smellCategories: string[];
  refactorHints: string[];
  metrics: {
    lineCount: number;
    functionCount: number;
    dependencyCount: number;
    serviceCount: number;
    sideEffectCount: number;
    strictMode: boolean;
  };
  findings: QualityFinding[];
}

type ScriptSnapshot = {
  node: StructureMapNodeRecord;
  summary?: ScriptSummaryRecord;
};

function normalizeString(value?: string | null) {
  return (value || '').trim();
}

function scriptSnapshotList(
  snapshot: PersistedStructureMapSnapshot,
  filters: ArchitectureAnalysisFilters = {},
): ScriptSnapshot[] {
  const limit = filters.limit ?? 25;
  const pathPrefix = normalizeString(filters.pathPrefix).toLowerCase();
  const subsystem = normalizeString(filters.subsystem).toLowerCase();
  const scriptType = normalizeString(filters.scriptType).toLowerCase();
  const list: ScriptSnapshot[] = [];

  for (const path of snapshot.scriptInventory) {
    const node = snapshot.nodesByPath[path];
    if (!node?.hasSource) continue;
    if (pathPrefix && !node.path.toLowerCase().includes(pathPrefix)) continue;
    if (subsystem && (node.subsystem || '').toLowerCase() !== subsystem) continue;
    if (scriptType && (node.scriptType || '').toLowerCase() !== scriptType) continue;
    list.push({
      node,
      summary: snapshot.summaryIndex[path],
    });
    if (list.length >= limit) break;
  }

  return list;
}

function uniqueSorted(items: string[]) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function severityWeight(severity: AnalysisSeverity) {
  switch (severity) {
    case 'high':
      return 18;
    case 'medium':
      return 10;
    default:
      return 5;
  }
}

function summarizeSubsystems(scripts: ScriptSnapshot[]) {
  const buckets = new Map<string, { scriptCount: number; servicesUsed: Set<string>; dependencies: Set<string> }>();

  for (const script of scripts) {
    const subsystem = script.node.subsystem || script.summary?.subsystem || 'Unknown';
    const bucket = buckets.get(subsystem) || {
      scriptCount: 0,
      servicesUsed: new Set<string>(),
      dependencies: new Set<string>(),
    };
    bucket.scriptCount += 1;
    for (const service of script.summary?.servicesUsed || []) bucket.servicesUsed.add(service);
    for (const dependency of script.summary?.dependencies || []) bucket.dependencies.add(dependency);
    buckets.set(subsystem, bucket);
  }

  return [...buckets.entries()]
    .map(([subsystem, data]) => ({
      subsystem,
      scriptCount: data.scriptCount,
      servicesUsed: [...data.servicesUsed].sort((a, b) => a.localeCompare(b)),
      dependencies: [...data.dependencies].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => b.scriptCount - a.scriptCount || a.subsystem.localeCompare(b.subsystem));
}

function hotspotScore(script: ScriptSnapshot) {
  const dependencyCount = script.summary?.dependencies?.length || 0;
  const serviceCount = script.summary?.servicesUsed?.length || 0;
  const sideEffectCount = script.summary?.sideEffects?.length || 0;
  const scriptWeight = script.node.scriptType === 'ModuleScript' ? 0 : 2;
  return (dependencyCount * 4) + (serviceCount * 3) + (sideEffectCount * 2) + scriptWeight;
}

function architectureRisks(scripts: ScriptSnapshot[]): ArchitectureRisk[] {
  const risks: ArchitectureRisk[] = [];

  for (const script of scripts) {
    const dependencyCount = script.summary?.dependencies?.length || 0;
    const serviceCount = script.summary?.servicesUsed?.length || 0;
    const sideEffects = script.summary?.sideEffects || [];
    const path = script.node.path;

    if (dependencyCount >= 2) {
      risks.push({
        category: 'coupling',
        severity: dependencyCount >= 4 ? 'high' : 'medium',
        path,
        reason: `${path} depends on ${dependencyCount} modules and may be taking on too much coordination work.`,
      });
    }
    if (serviceCount >= 3) {
      risks.push({
        category: 'service-sprawl',
        severity: serviceCount >= 5 ? 'high' : 'medium',
        path,
        reason: `${path} touches ${serviceCount} Roblox services, which is a signal for boundary drift.`,
      });
    }
    if (sideEffects.includes('infinite-loop')) {
      risks.push({
        category: 'runtime-loop',
        severity: 'high',
        path,
        reason: `${path} contains an infinite-loop side-effect pattern and should be checked for yield discipline and shutdown behavior.`,
      });
    }
    if ((script.node.summaryStatus || 'missing') !== 'fresh') {
      risks.push({
        category: 'stale-summary',
        severity: 'low',
        path,
        reason: `${path} does not have a fresh cached summary, so downstream AI reasoning may have degraded context.`,
      });
    }
  }

  return risks
    .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || a.path.localeCompare(b.path))
    .slice(0, 12);
}

function detectEntrypoints(scripts: ScriptSnapshot[]) {
  return scripts
    .filter((script) => {
      const type = script.node.scriptType || script.node.className;
      const sideEffects = script.summary?.sideEffects || [];
      return type === 'Script' || type === 'LocalScript' ||
        sideEffects.includes('remote-server-listener') ||
        sideEffects.includes('remote-client-listener');
    })
    .map((script) => ({
      path: script.node.path,
      scriptType: script.node.scriptType || null,
      reason: script.node.scriptType === 'Script' || script.node.scriptType === 'LocalScript'
        ? 'top-level runtime script'
        : 'event-driven side-effect pattern',
    }))
    .slice(0, 12);
}

export function analyzeArchitectureSnapshot(
  snapshot: PersistedStructureMapSnapshot,
  filters: ArchitectureAnalysisFilters = {},
): ArchitectureReport {
  const scripts = scriptSnapshotList(snapshot, filters);
  const subsystems = summarizeSubsystems(scripts);
  const hotspots = scripts
    .map((script) => ({
      path: script.node.path,
      subsystem: script.node.subsystem || script.summary?.subsystem || null,
      score: hotspotScore(script),
      dependencyCount: script.summary?.dependencies?.length || 0,
      serviceCount: script.summary?.servicesUsed?.length || 0,
      sideEffectCount: script.summary?.sideEffects?.length || 0,
      summaryShort: script.summary?.summaryShort || null,
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 10);
  const entrypoints = detectEntrypoints(scripts);
  const risks = architectureRisks(scripts);

  return {
    filters: {
      ...filters,
      includeDependencies: filters.includeDependencies ?? false,
    },
    summary: {
      scriptCount: scripts.length,
      subsystemCount: subsystems.length,
      entrypointCount: entrypoints.length,
      hotspotCount: hotspots.length,
    },
    subsystems,
    scripts: scripts.map((script) => ({
      path: script.node.path,
      className: script.node.className,
      scriptType: script.node.scriptType || null,
      subsystem: script.node.subsystem || script.summary?.subsystem || null,
      summaryShort: script.summary?.summaryShort || null,
      dependencyCount: script.summary?.dependencies?.length || 0,
      serviceCount: script.summary?.servicesUsed?.length || 0,
      sideEffectCount: script.summary?.sideEffects?.length || 0,
    })),
    hotspots,
    entrypoints,
    risks,
  };
}

function pushFinding(
  findings: QualityFinding[],
  input: ScriptQualityInput,
  finding: Omit<QualityFinding, 'scriptPath'>,
) {
  findings.push({
    scriptPath: input.path,
    ...finding,
  });
}

export function analyzeScriptQuality(input: ScriptQualityInput): ScriptQualityReport {
  const findings: QualityFinding[] = [];
  const lines = input.source.split(/\r?\n/);
  const strictMode = /^\s*--!strict\b/m.test(input.source);
  const functionCount = [...input.source.matchAll(/\bfunction\b/g)].length;
  const dependencyCount = input.dependencies.length;
  const serviceCount = input.servicesUsed.length;
  const sideEffectCount = input.sideEffects.length;

  if (!strictMode) {
    pushFinding(findings, input, {
      severity: 'medium',
      category: 'strict-mode',
      title: 'Script is missing --!strict',
      detail: 'Strict type checking is not enabled for this script.',
      suggestion: 'Add `--!strict` at the top once the script passes Luau type analysis.',
      evidence: lines[0] || '',
    });
  }

  if (/\bwait\s*\(/.test(input.source)) {
    pushFinding(findings, input, {
      severity: 'medium',
      category: 'legacy-wait',
      title: 'Legacy wait() usage',
      detail: 'Legacy scheduler APIs make timing less predictable and complicate reasoning about yielding behavior.',
      suggestion: 'Replace `wait()` with `task.wait()` or an explicit scheduling abstraction.',
      evidence: 'wait(',
    });
  }

  if (/\bspawn\s*\(/.test(input.source)) {
    pushFinding(findings, input, {
      severity: 'medium',
      category: 'legacy-spawn',
      title: 'Legacy spawn() usage',
      detail: 'Legacy spawn() is less predictable than task scheduling helpers.',
      suggestion: 'Replace `spawn()` with `task.spawn()` or a bounded worker abstraction.',
      evidence: 'spawn(',
    });
  }

  if (/GetCollisionGroups\s*\(/.test(input.source)) {
    pushFinding(findings, input, {
      severity: 'high',
      category: 'deprecated-api',
      title: 'Deprecated PhysicsService API usage',
      detail: 'The script uses `GetCollisionGroups()`, which this repo already treats as deprecated.',
      suggestion: 'Use `PhysicsService:GetRegisteredCollisionGroups()` instead.',
      evidence: 'GetCollisionGroups(',
    });
  }

  if (/\bwhile\s+true\s+do\b/.test(input.source) || input.sideEffects.includes('infinite-loop')) {
    pushFinding(findings, input, {
      severity: 'high',
      category: 'infinite-loop',
      title: 'Unbounded loop detected',
      detail: 'Infinite loops are valid in Roblox, but they need explicit yield, shutdown, and ownership discipline.',
      suggestion: 'Confirm the loop has a clear owner, yield policy, and teardown condition.',
      evidence: 'while true do',
    });
  }

  if (dependencyCount >= 5) {
    pushFinding(findings, input, {
      severity: dependencyCount >= 7 ? 'high' : 'medium',
      category: 'high-coupling',
      title: 'High dependency count',
      detail: `The script depends on ${dependencyCount} modules.`,
      suggestion: 'Split orchestration from domain logic or introduce a smaller façade module.',
    });
  }

  if (serviceCount >= 4) {
    pushFinding(findings, input, {
      severity: serviceCount >= 6 ? 'high' : 'medium',
      category: 'service-sprawl',
      title: 'Many Roblox services used directly',
      detail: `The script references ${serviceCount} services directly.`,
      suggestion: 'Consider extracting service coordination into a focused adapter or helper.',
    });
  }

  if (lines.length >= 250) {
    pushFinding(findings, input, {
      severity: lines.length >= 400 ? 'medium' : 'low',
      category: 'large-script',
      title: 'Large script body',
      detail: `The script has ${lines.length} lines.`,
      suggestion: 'Split the script by responsibility before adding more behavior.',
    });
  }

  if (functionCount >= 12) {
    pushFinding(findings, input, {
      severity: functionCount >= 20 ? 'medium' : 'low',
      category: 'many-functions',
      title: 'High function density',
      detail: `The script declares ${functionCount} functions.`,
      suggestion: 'Check whether some behaviors should move into separate modules.',
    });
  }

  const score = Math.max(0, 100 - findings.reduce((sum, finding) => sum + severityWeight(finding.severity), 0));
  const smellCategories = uniqueSorted(findings.map((finding) => finding.category));
  const refactorHints = uniqueSorted(findings.map((finding) => finding.suggestion)).slice(0, 6);
  const riskLevel = score >= 85 ? 'low' : score >= 65 ? 'moderate' : 'high';

  return {
    path: input.path,
    className: input.className,
    scriptType: input.scriptType || null,
    subsystem: input.subsystem || null,
    summaryShort: input.summaryShort || null,
    score,
    riskLevel,
    smellCategories,
    refactorHints,
    metrics: {
      lineCount: lines.length,
      functionCount,
      dependencyCount,
      serviceCount,
      sideEffectCount,
      strictMode,
    },
    findings,
  };
}
