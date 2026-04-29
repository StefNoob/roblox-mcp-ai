import path from 'path';
import type { ScriptSummaryRecord } from './structure-map-cache.js';

export interface ScriptSummaryInput {
  instancePath: string;
  source: string;
  sourceHash?: string;
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

function inferSubsystemFromPath(instancePath: string) {
  const segments = instancePath.replace(/^game\./, '').split('.');
  const keywords = ['AI', 'Combat', 'Inventory', 'UI', 'Tycoon', 'Data', 'Player', 'Shop', 'Quest', 'NPC'];
  const found = segments.find((segment) => keywords.some((keyword) => segment.toLowerCase().includes(keyword.toLowerCase())));
  return found || segments[1] || segments[0] || 'Game';
}

function detectExports(source: string) {
  const exports: string[] = [];
  const functionMatches = source.matchAll(/function\s+([A-Za-z0-9_.]+)\s*\(/g);
  for (const match of functionMatches) {
    exports.push(match[1]);
  }
  const localFunctionMatches = source.matchAll(/local\s+function\s+([A-Za-z0-9_]+)\s*\(/g);
  for (const match of localFunctionMatches) {
    exports.push(match[1]);
  }
  return unique(exports).slice(0, 12);
}

function detectDependencies(source: string) {
  const dependencies: string[] = [];
  const matches = source.matchAll(/require\(([^)]+)\)/g);
  for (const match of matches) {
    dependencies.push(match[1].trim());
  }
  return unique(dependencies);
}

function detectServices(source: string) {
  const services: string[] = [];
  const matches = source.matchAll(/game:GetService\((['"])([^'"]+)\1\)/g);
  for (const match of matches) {
    services.push(match[2]);
  }
  return unique(services);
}

function detectSideEffects(source: string) {
  const sideEffects: string[] = [];
  const candidates: Array<[RegExp, string]> = [
    [/OnServerEvent/g, 'remote-server-listener'],
    [/OnClientEvent/g, 'remote-client-listener'],
    [/FireServer/g, 'remote-fire-server'],
    [/FireClient/g, 'remote-fire-client'],
    [/FireAllClients/g, 'remote-fire-all'],
    [/while\s+true\s+do/g, 'infinite-loop'],
    [/task\.spawn/g, 'task-spawn'],
    [/task\.wait/g, 'task-wait'],
    [/DataStoreService/g, 'datastore'],
    [/Players\./g, 'player-side-effect'],
  ];
  for (const [pattern, label] of candidates) {
    if (pattern.test(source)) {
      sideEffects.push(label);
    }
  }
  return sideEffects;
}

export function summarizeScriptSource(input: ScriptSummaryInput): ScriptSummaryRecord {
  const name = path.basename(input.instancePath.split('.').join(path.sep));
  const subsystem = inferSubsystemFromPath(input.instancePath);
  const dependencies = detectDependencies(input.source);
  const servicesUsed = detectServices(input.source);
  const sideEffects = detectSideEffects(input.source);
  const exports = detectExports(input.source);
  const purpose = `${name} belongs to the ${subsystem} subsystem`;
  const summaryBits = [
    `${name} script`,
    `subsystem ${subsystem}`,
    servicesUsed.length > 0 ? `services ${servicesUsed.join(', ')}` : '',
    dependencies.length > 0 ? `dependencies ${dependencies.join(', ')}` : '',
  ].filter(Boolean);

  return {
    path: input.instancePath,
    sourceHash: input.sourceHash ?? '',
    summaryShort: summaryBits.join(' | '),
    summaryLong: `${purpose}. Exports ${exports.length} symbol(s) and has ${sideEffects.length} notable side-effect pattern(s).`,
    purpose,
    exports,
    dependencies,
    servicesUsed,
    sideEffects,
    subsystem,
    updatedAt: Date.now(),
  };
}
