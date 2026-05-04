import type {
  PersistedStructureMapSnapshot,
  ScriptSummaryRecord,
  StructureMapNodeRecord,
} from './structure-map-cache.js';
import type { ScriptQualityReport } from './analysis-tools.js';

export type ContextPriority = 'critical' | 'high' | 'normal' | 'low';

export interface ContextItem {
  type: 'script_summary' | 'architecture_note' | 'dependency_hint' | 'quality_finding' | 'relationship_edge';
  priority: ContextPriority;
  payload: any;
  estimatedTokens: number;
  relevanceScore: number; // 0-100, higher = more relevant to current query
}

export interface ContextBudget {
  maxTokens: number;
  reserveForCritical: number; // tokens always reserved for critical items
  minRelevanceThreshold: number; // items below this relevance are dropped
}

export interface ContextPackage {
  manifest: {
    totalItems: number;
    totalTokens: number;
    tokenBudget: number;
    priorityBreakdown: Record<ContextPriority, number>;
    droppedCount: number;
  };
  focusArea: {
    primaryPaths: string[];
    relatedSubsystems: string[];
    riskLevel: 'low' | 'moderate' | 'high';
  };
  items: ContextItem[];
  quickNav: {
    hotspots: string[];
    entrypoints: string[];
    crossScriptDeps: Array<{ from: string; to: string; type: string }>;
  };
}

export interface ContextPreferences {
  preferArchitecture?: boolean;
  preferQuality?: boolean;
  preferDependencies?: boolean;
  maxScripts?: number;
  maxFindings?: number;
  tokenBudget?: number;
}

export class ContextEngine {
  private budget: ContextBudget;

  constructor(budget?: Partial<ContextBudget>) {
    this.budget = {
      maxTokens: budget?.maxTokens ?? 8000,
      reserveForCritical: budget?.reserveForCritical ?? 1500,
      minRelevanceThreshold: budget?.minRelevanceThreshold ?? 15,
    };
  }

  configureBudget(patch: Partial<ContextBudget>) {
    this.budget = { ...this.budget, ...patch };
  }

  /**
   * Assemble a context package optimized for AI consumption.
   * Uses token budgeting to maximize information density.
   */
  assembleContext(
    snapshot: PersistedStructureMapSnapshot,
    options: {
      focusPaths?: string[];
      focusSubsystems?: string[];
      qualityReports?: Map<string, ScriptQualityReport>;
      preferences?: ContextPreferences;
    } = {},
  ): ContextPackage {
    const prefs = options.preferences || {};
    const items: ContextItem[] = [];
    const focusPaths = new Set(options.focusPaths || []);
    const focusSubsystems = new Set(options.focusSubsystems || []);
    const effectiveBudget = prefs.tokenBudget ?? this.budget.maxTokens;
    const criticalReserve = this.budget.reserveForCritical;
    const softBudget = effectiveBudget - criticalReserve;

    // 1. Build relationship graph (who calls whom)
    const relationships = this.buildRelationshipGraph(snapshot);

    // 2. Add critical items: focus scripts with full summaries
    const focusNodes = this.selectFocusNodes(snapshot, focusPaths, focusSubsystems, prefs.maxScripts ?? 12);
    for (const node of focusNodes) {
      const summary = snapshot.summaryIndex[node.path];
      const relevance = this.computeRelevance(node, summary, focusPaths, focusSubsystems);
      if (relevance < this.budget.minRelevanceThreshold) continue;

      items.push({
        type: 'script_summary',
        priority: 'critical',
        payload: this.compressScriptSummary(node, summary),
        estimatedTokens: this.estimateTokens(node, summary),
        relevanceScore: relevance,
      });

      // Add dependency hints for critical nodes
      const deps = relationships.get(node.path) || [];
      for (const dep of deps.slice(0, 4)) {
        items.push({
          type: 'dependency_hint',
          priority: 'high',
          payload: dep,
          estimatedTokens: 40,
          relevanceScore: relevance * 0.9,
        });
      }
    }

    // 3. Add architecture notes for subsystems touched by focus
    const touchedSubsystems = new Set<string>();
    for (const node of focusNodes) {
      const sub = node.subsystem || snapshot.summaryIndex[node.path]?.subsystem;
      if (sub) touchedSubsystems.add(sub);
    }
    for (const subsystem of touchedSubsystems) {
      const scriptsInSub = snapshot.scriptInventory
        .map((p) => snapshot.nodesByPath[p])
        .filter((n) => (n.subsystem || snapshot.summaryIndex[n.path]?.subsystem) === subsystem);
      items.push({
        type: 'architecture_note',
        priority: 'high',
        payload: {
          subsystem,
          scriptCount: scriptsInSub.length,
          services: [...new Set(scriptsInSub.flatMap((n) => snapshot.summaryIndex[n.path]?.servicesUsed || []))],
          entrypoints: scriptsInSub
            .filter((n) => n.scriptType === 'Script' || n.scriptType === 'LocalScript')
            .map((n) => n.path)
            .slice(0, 5),
        },
        estimatedTokens: 80,
        relevanceScore: 85,
      });
    }

    // 4. Add quality findings if available
    if (options.qualityReports) {
      const maxFindings = prefs.maxFindings ?? 15;
      let findingCount = 0;
      for (const [path, report] of options.qualityReports) {
        if (findingCount >= maxFindings) break;
        const isFocus = focusPaths.has(path) || focusSubsystems.has(report.subsystem || '');
        const severityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
        const sortedFindings = [...report.findings].sort(
          (a, b) => severityOrder[b.severity] - severityOrder[a.severity],
        );
        for (const finding of sortedFindings.slice(0, isFocus ? 3 : 1)) {
          items.push({
            type: 'quality_finding',
            priority: isFocus ? 'high' : 'normal',
            payload: {
              path,
              severity: finding.severity,
              category: finding.category,
              title: finding.title,
              suggestion: finding.suggestion,
            },
            estimatedTokens: 50,
            relevanceScore: isFocus ? 80 : 50,
          });
          findingCount++;
        }
      }
    }

    // 5. Budget-aware ranking, deduplication, and truncation
    const deduped = this.deduplicateItems(items);
    const topologicallySorted = this.topologicalRank(deduped, relationships);
    const typeBudgets = this.allocateBudget(effectiveBudget);
    const typeUsed: Record<string, number> = {};
    const selected: ContextItem[] = [];
    let usedTokens = 0;
    let dropped = 0;
    const priorityUsed: Record<ContextPriority, number> = { critical: 0, high: 0, normal: 0, low: 0 };

    for (const item of topologicallySorted) {
      const typeBudget = typeBudgets[item.type] || softBudget;
      const typeUsedSoFar = typeUsed[item.type] || 0;
      const typeHasRoom = typeUsedSoFar + item.estimatedTokens <= typeBudget;
      const fitsInSoft = usedTokens + item.estimatedTokens <= softBudget;
      const isCritical = item.priority === 'critical';
      const fitsCritical = isCritical && usedTokens + item.estimatedTokens <= effectiveBudget;
      if ((fitsInSoft || fitsCritical) && typeHasRoom) {
        selected.push(item);
        usedTokens += item.estimatedTokens;
        priorityUsed[item.priority] += 1;
        typeUsed[item.type] = typeUsedSoFar + item.estimatedTokens;
      } else {
        dropped += 1;
      }
    }

    // 6. Compute quick nav index
    const hotspots = this.computeHotspots(snapshot).slice(0, 8);
    const entrypoints = snapshot.scriptInventory
      .map((p) => snapshot.nodesByPath[p])
      .filter((n) => n.scriptType === 'Script' || n.scriptType === 'LocalScript')
      .map((n) => n.path)
      .slice(0, 8);
    const crossScriptDeps = [...relationships.entries()]
      .flatMap(([from, deps]) => deps.map((d) => ({ from, to: d.to, type: d.type })))
      .slice(0, 12);

    // 7. Compute overall risk
    const allScores = options.qualityReports
      ? [...options.qualityReports.values()].map((r) => r.score)
      : [];
    const avgScore = allScores.length > 0
      ? allScores.reduce((a, b) => a + b, 0) / allScores.length
      : 100;
    const riskLevel = avgScore >= 85 ? 'low' : avgScore >= 60 ? 'moderate' : 'high';

    return {
      manifest: {
        totalItems: selected.length,
        totalTokens: usedTokens,
        tokenBudget: effectiveBudget,
        priorityBreakdown: priorityUsed,
        droppedCount: dropped,
      },
      focusArea: {
        primaryPaths: focusNodes.map((n) => n.path),
        relatedSubsystems: [...touchedSubsystems],
        riskLevel,
      },
      items: selected,
      quickNav: {
        hotspots,
        entrypoints,
        crossScriptDeps,
      },
    };
  }

  private buildRelationshipGraph(
    snapshot: PersistedStructureMapSnapshot,
  ): Map<string, Array<{ to: string; type: string; strength: number }>> {
    const graph = new Map<string, Array<{ to: string; type: string; strength: number }>>();
    const pathToNode = new Map<string, StructureMapNodeRecord>();
    for (const p of snapshot.scriptInventory) {
      pathToNode.set(p, snapshot.nodesByPath[p]);
    }

    for (const scriptPath of snapshot.scriptInventory) {
      const summary = snapshot.summaryIndex[scriptPath];
      if (!summary?.dependencies?.length) continue;

      const edges: Array<{ to: string; type: string; strength: number }> = [];
      for (const dep of summary.dependencies) {
        // Try to resolve dependency to a known script path
        const resolved = this.resolveDependencyPath(dep, snapshot, pathToNode);
        if (resolved) {
          // Check if bidirectional (mutual dependency)
          const otherSummary = snapshot.summaryIndex[resolved];
          const bidirectional = otherSummary?.dependencies?.some((d) =>
            this.resolveDependencyPath(d, snapshot, pathToNode) === scriptPath,
          );
          edges.push({
            to: resolved,
            type: bidirectional ? 'bidirectional' : 'requires',
            strength: bidirectional ? 3 : 2,
          });
        } else {
          // External / unresolved dependency
          edges.push({ to: dep, type: 'external', strength: 1 });
        }
      }
      graph.set(scriptPath, edges);
    }
    return graph;
  }

  private resolveDependencyPath(
    dep: string,
    snapshot: PersistedStructureMapSnapshot,
    pathToNode: Map<string, StructureMapNodeRecord>,
  ): string | null {
    // Direct path match
    if (pathToNode.has(dep)) return dep;
    // Try matching last segment
    const segments = dep.split(/[./]/);
    const lastSeg = segments[segments.length - 1];
    for (const [path, node] of pathToNode) {
      if (node.name === lastSeg) return path;
    }
    return null;
  }

  private selectFocusNodes(
    snapshot: PersistedStructureMapSnapshot,
    focusPaths: Set<string>,
    focusSubsystems: Set<string>,
    maxScripts: number,
  ): StructureMapNodeRecord[] {
    const candidates: Array<{ node: StructureMapNodeRecord; score: number }> = [];
    for (const path of snapshot.scriptInventory) {
      const node = snapshot.nodesByPath[path];
      if (!node?.hasSource) continue;

      let score = 0;
      if (focusPaths.has(path)) score += 100;
      const summary = snapshot.summaryIndex[path];
      const subsystem = node.subsystem || summary?.subsystem;
      if (subsystem && focusSubsystems.has(subsystem)) score += 50;

      // Hotspot bonus
      const depCount = summary?.dependencies?.length || 0;
      const svcCount = summary?.servicesUsed?.length || 0;
      const effCount = summary?.sideEffects?.length || 0;
      score += depCount * 3 + svcCount * 2 + effCount * 2;
      if (node.scriptType === 'Script' || node.scriptType === 'LocalScript') score += 5;

      candidates.push({ node, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxScripts).map((c) => c.node);
  }

  private computeRelevance(
    node: StructureMapNodeRecord,
    summary: ScriptSummaryRecord | undefined,
    focusPaths: Set<string>,
    focusSubsystems: Set<string>,
  ): number {
    let score = 40; // base relevance for any script
    if (focusPaths.has(node.path)) score += 60;
    const subsystem = node.subsystem || summary?.subsystem;
    if (subsystem && focusSubsystems.has(subsystem)) score += 30;
    const depCount = summary?.dependencies?.length || 0;
    if (depCount > 0) score += Math.min(depCount * 3, 20);
    if ((summary?.sideEffects?.length || 0) > 0) score += 10;
    return Math.min(100, score);
  }

  private compressScriptSummary(node: StructureMapNodeRecord, summary?: ScriptSummaryRecord): any {
    return {
      path: node.path,
      className: node.className,
      scriptType: node.scriptType,
      subsystem: node.subsystem || summary?.subsystem || null,
      exports: summary?.exports?.slice(0, 8) || [],
      dependencies: summary?.dependencies?.slice(0, 8) || [],
      servicesUsed: summary?.servicesUsed?.slice(0, 6) || [],
      sideEffects: summary?.sideEffects?.slice(0, 4) || [],
      summaryShort: summary?.summaryShort || null,
      purpose: summary?.purpose || null,
    };
  }

  private topologicalRank(
    items: ContextItem[],
    relationships: Map<string, Array<{ to: string; type: string; strength: number }>>,
  ): ContextItem[] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    // Initialize
    for (const item of items) {
      if (item.type === 'script_summary') {
        inDegree.set(item.payload.path, 0);
        adj.set(item.payload.path, []);
      }
    }

    // Build graph from relationships
    for (const [from, deps] of relationships) {
      for (const dep of deps) {
        if (adj.has(from) && inDegree.has(dep.to)) {
          adj.get(dep.to)!.push(from);
          inDegree.set(from, (inDegree.get(from) || 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [path, degree] of inDegree) {
      if (degree === 0) queue.push(path);
    }
    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const neighbor of adj.get(current) || []) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    const orderIndex = new Map(order.map((p, i) => [p, i]));
    return [...items].sort((a, b) => {
      const aIsScript = a.type === 'script_summary';
      const bIsScript = b.type === 'script_summary';
      if (!aIsScript && !bIsScript) return 0;
      if (!aIsScript) return -1;
      if (!bIsScript) return 1;
      const aIdx = orderIndex.get(a.payload.path) ?? Infinity;
      const bIdx = orderIndex.get(b.payload.path) ?? Infinity;
      return aIdx - bIdx;
    });
  }

  private deduplicateItems(items: ContextItem[]): ContextItem[] {
    const seen = new Set<string>();
    const result: ContextItem[] = [];
    for (const item of items) {
      let key: string;
      switch (item.type) {
        case 'script_summary':
          key = `ss:${item.payload.path}`;
          break;
        case 'dependency_hint':
          key = `dh:${item.payload.from}:${item.payload.to}`;
          break;
        case 'architecture_note':
          key = `an:${item.payload.subsystem}`;
          break;
        case 'quality_finding':
          key = `qf:${item.payload.path}:${item.payload.title}`;
          break;
        case 'relationship_edge':
          key = `re:${item.payload.from}:${item.payload.to}`;
          break;
        default:
          key = JSON.stringify(item.payload);
      }
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
    return result;
  }

  private allocateBudget(effectiveBudget: number): Record<string, number> {
    return {
      script_summary: Math.floor(effectiveBudget * 0.50),
      architecture_note: Math.floor(effectiveBudget * 0.20),
      dependency_hint: Math.floor(effectiveBudget * 0.15),
      quality_finding: Math.floor(effectiveBudget * 0.10),
      relationship_edge: Math.floor(effectiveBudget * 0.05),
    };
  }

  private estimateTokens(node: StructureMapNodeRecord, summary?: ScriptSummaryRecord): number {
    const base = 80;
    const exportsTokens = (summary?.exports?.length || 0) * 12;
    const depsTokens = (summary?.dependencies?.length || 0) * 14;
    const servicesTokens = (summary?.servicesUsed?.length || 0) * 10;
    const sideEffectsTokens = (summary?.sideEffects?.length || 0) * 8;
    const patternsTokens = ((summary as any)?.patterns?.length || 0) * 6;
    const lifecycleTokens = ((summary as any)?.lifecycleHooks?.length || 0) * 8;
    return base + exportsTokens + depsTokens + servicesTokens + sideEffectsTokens + patternsTokens + lifecycleTokens;
  }

  private rankByValue(items: ContextItem[]): ContextItem[] {
    return [...items].sort((a, b) => {
      const priorityOrder: Record<ContextPriority, number> = { critical: 4, high: 3, normal: 2, low: 1 };
      const pa = priorityOrder[a.priority];
      const pb = priorityOrder[b.priority];
      if (pa !== pb) return pb - pa;
      // Within same priority, sort by relevance density (relevance per token)
      const densityA = a.relevanceScore / Math.max(1, a.estimatedTokens);
      const densityB = b.relevanceScore / Math.max(1, b.estimatedTokens);
      return densityB - densityA;
    });
  }

  private computeHotspots(snapshot: PersistedStructureMapSnapshot): string[] {
    const scored = snapshot.scriptInventory.map((path) => {
      const node = snapshot.nodesByPath[path];
      const summary = snapshot.summaryIndex[path];
      const depCount = summary?.dependencies?.length || 0;
      const svcCount = summary?.servicesUsed?.length || 0;
      const effCount = summary?.sideEffects?.length || 0;
      const weight = node.scriptType === 'ModuleScript' ? 0 : 2;
      return {
        path,
        score: depCount * 4 + svcCount * 3 + effCount * 2 + weight,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.path);
  }
}
