import type {
  PersistedStructureMapSnapshot,
  ScriptSummaryRecord,
  StructureMapNodeRecord,
} from './structure-map-cache.js';
import type { EnhancedScriptSummaryRecord } from './script-summary.js';

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
  patterns?: string[];
  complexity?: {
    cyclomaticApprox: number;
    nestingDepth: number;
    avgFunctionLength: number;
  };
  apiSurface?: string[];
  stateAccess?: string[];
  lifecycleHooks?: string[];
  crossScriptCalls?: string[];
  eventHandlers?: string[];
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
    cyclomaticApprox: number;
    nestingDepth: number;
    avgFunctionLength: number;
  };
  patterns: string[];
  apiSurface: string[];
  stateAccess: string[];
  lifecycleHooks: string[];
  eventHandlers: string[];
  findings: QualityFinding[];
}

type ScriptSnapshot = {
  node: StructureMapNodeRecord;
  summary?: ScriptSummaryRecord | EnhancedScriptSummaryRecord;
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
  const enhanced = script.summary as EnhancedScriptSummaryRecord | undefined;
  const complexityBonus = enhanced?.complexity
    ? Math.min(enhanced.complexity.cyclomaticApprox / 5, 5)
    : 0;
  return (dependencyCount * 4) + (serviceCount * 3) + (sideEffectCount * 2) + scriptWeight + complexityBonus;
}

function architectureRisks(scripts: ScriptSnapshot[]): ArchitectureRisk[] {
  const risks: ArchitectureRisk[] = [];
  const pathToDeps = new Map<string, string[]>();

  for (const script of scripts) {
    pathToDeps.set(script.node.path, script.summary?.dependencies || []);
  }

  // Detect circular dependencies
  for (const script of scripts) {
    const deps = pathToDeps.get(script.node.path) || [];
    for (const dep of deps) {
      const depDeps = pathToDeps.get(dep) || [];
      if (depDeps.includes(script.node.path)) {
        risks.push({
          category: 'circular-dependency',
          severity: 'high',
          path: script.node.path,
          reason: `${script.node.path} and ${dep} have a circular dependency. Consider merging or introducing an intermediate abstraction.`,
        });
      }
    }
  }

  // Detect god objects (high coupling AND high complexity)
  for (const script of scripts) {
    const dependencyCount = script.summary?.dependencies?.length || 0;
    const serviceCount = script.summary?.servicesUsed?.length || 0;
    const sideEffects = script.summary?.sideEffects || [];
    const path = script.node.path;
    const enhanced = script.summary as EnhancedScriptSummaryRecord | undefined;

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

    // God object detection: high coupling + many services + many side effects
    const isGodObject = dependencyCount >= 6 && serviceCount >= 4 && sideEffects.length >= 4;
    if (isGodObject) {
      risks.push({
        category: 'god-object',
        severity: 'high',
        path,
        reason: `${path} is a god object with ${dependencyCount} deps, ${serviceCount} services, ${sideEffects.length} side effects. Consider splitting into focused modules.`,
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
    if (enhanced?.complexity && enhanced.complexity.nestingDepth >= 5) {
      risks.push({
        category: 'deep-nesting',
        severity: enhanced.complexity.nestingDepth >= 7 ? 'high' : 'medium',
        path,
        reason: `${path} has nested depth ${enhanced.complexity.nestingDepth}, which makes the control flow harder to follow.`,
      });
    }
  }

  return risks
    .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || a.path.localeCompare(b.path))
    .slice(0, 12);
}

function computeCohesionScore(scripts: ScriptSnapshot[], pathToDeps: Map<string, string[]>): Map<string, number> {
  const scores = new Map<string, number>();
  
  for (const script of scripts) {
    const path = script.node.path;
    const deps = pathToDeps.get(path) || [];
    if (deps.length < 2) {
      scores.set(path, 1.0); // Perfect cohesion or trivial module
      continue;
    }

    // Check if all dependencies serve a similar purpose
    const depSubsystems = new Set(deps.map(dep => {
      const depScript = scripts.find(s => s.node.path === dep);
      return depScript?.node.subsystem || depScript?.summary?.subsystem || '';
    }).filter(Boolean));

    const subsystem = script.node.subsystem || script.summary?.subsystem || '';
    
    // Cohesion is higher when all deps belong to same subsystem
    const sameSubsystemDeps = [...depSubsystems].filter(s => s === subsystem).length;
    const cohesion = depSubsystems.size === 0 
      ? 1.0 
      : 0.3 + (0.7 * (sameSubsystemDeps / depSubsystems.size));
    
    scores.set(path, Math.round(cohesion * 100) / 100);
  }

  return scores;
}

function computePagerankHotspots(scripts: ScriptSnapshot[]): Array<{ path: string; score: number }> {
  const pathSet = new Set(scripts.map(s => s.node.path));
  const adj = new Map<string, Set<string>>();
  
  for (const script of scripts) {
    const deps = script.summary?.dependencies || [];
    adj.set(script.node.path, new Set(deps.filter(d => pathSet.has(d))));
  }

  const paths = [...pathSet];
  const damping = 0.85;
  const iterations = 20;
  let pr = new Map(paths.map(p => [p, 1 / paths.length]));

  for (let i = 0; i < iterations; i++) {
    const newPr = new Map<string, number>();
    for (const path of paths) {
      let sum = 0;
      for (const [otherPath, otherDeps] of adj) {
        if (otherDeps.has(path)) {
          const outDegree = otherDeps.size || 1;
          sum += (pr.get(otherPath) || 0) / outDegree;
        }
      }
      newPr.set(path, (1 - damping) / paths.length + damping * sum);
    }
    pr = newPr;
  }

  return paths
    .map(path => ({ path, score: Math.round((pr.get(path) || 0) * 1000) }))
    .sort((a, b) => b.score - a.score);
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
      suggestion: 'Split orchestration from domain logic or introduce a smaller facade module.',
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

  // Enhanced findings from new metadata
  if (input.complexity) {
    if (input.complexity.cyclomaticApprox >= 15) {
      pushFinding(findings, input, {
        severity: input.complexity.cyclomaticApprox >= 25 ? 'high' : 'medium',
        category: 'high-complexity',
        title: 'High cyclomatic complexity',
        detail: `Approximated cyclomatic complexity is ${input.complexity.cyclomaticApprox}.`,
        suggestion: 'Extract helper functions to reduce branching paths.',
      });
    }
    if (input.complexity.nestingDepth >= 5) {
      pushFinding(findings, input, {
        severity: input.complexity.nestingDepth >= 7 ? 'high' : 'medium',
        category: 'deep-nesting',
        title: 'Deep nesting detected',
        detail: `Maximum nesting depth is ${input.complexity.nestingDepth}.`,
        suggestion: 'Flatten nested control flow with early returns or guard clauses.',
      });
    }
    if (input.complexity.avgFunctionLength >= 40) {
      pushFinding(findings, input, {
        severity: input.complexity.avgFunctionLength >= 60 ? 'medium' : 'low',
        category: 'long-functions',
        title: 'Long average function length',
        detail: `Average function length is ${input.complexity.avgFunctionLength} lines.`,
        suggestion: 'Break large functions into smaller, focused units.',
      });
    }
  }

  if (input.patterns && input.patterns.length === 0 && lines.length > 15) {
    pushFinding(findings, input, {
      severity: 'low',
      category: 'no-recognizable-patterns',
      title: 'No recognizable architectural patterns',
      detail: 'The script does not match common Roblox architectural patterns (Knit, Component, etc.).',
      suggestion: 'Consider adopting a lightweight framework for consistency.',
    });
  }

  if (input.lifecycleHooks && input.lifecycleHooks.length === 0) {
    // Only flag if it is a Script or LocalScript that probably should have lifecycle
    if (input.scriptType === 'Script' || input.scriptType === 'LocalScript') {
      pushFinding(findings, input, {
        severity: 'low',
        category: 'no-lifecycle-hooks',
        title: 'No lifecycle hooks detected',
        detail: 'The entrypoint script does not appear to handle PlayerAdded, CharacterAdded, or similar lifecycle events.',
        suggestion: 'Review whether the script should react to player or character lifecycle.',
      });
    }
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
      cyclomaticApprox: input.complexity?.cyclomaticApprox ?? 0,
      nestingDepth: input.complexity?.nestingDepth ?? 0,
      avgFunctionLength: input.complexity?.avgFunctionLength ?? 0,
    },
    patterns: input.patterns || [],
    apiSurface: input.apiSurface || [],
    stateAccess: input.stateAccess || [],
    lifecycleHooks: input.lifecycleHooks || [],
    eventHandlers: input.eventHandlers || [],
    findings,
  };
}
