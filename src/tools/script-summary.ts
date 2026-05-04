import path from 'path';
import type { ScriptSummaryRecord } from './structure-map-cache.js';

export interface ScriptSummaryInput {
  instancePath: string;
  source: string;
  sourceHash?: string;
}

export interface EnhancedScriptSummaryRecord extends ScriptSummaryRecord {
  patterns: string[];
  complexity: {
    cyclomaticApprox: number;
    nestingDepth: number;
    avgFunctionLength: number;
  };
  apiSurface: string[];
  stateAccess: string[];
  lifecycleHooks: string[];
  crossScriptCalls: string[];
  eventHandlers: string[];
  customEvents: string[];
  specializedServices: string[];
  attributes: string[];
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

function inferSubsystemFromPath(instancePath: string) {
  const segments = instancePath.replace(/^game\./, '').split('.');
  const keywords = [
    'AI', 'Combat', 'Inventory', 'UI', 'Tycoon', 'Data', 'Player', 'Shop',
    'Quest', 'NPC', 'Network', 'Animation', 'Camera', 'Audio', 'Leaderboard',
    'Weapon', 'Skill', 'Ability', 'Buff', 'Debuff', 'Enemy', 'Boss', 'Wave',
    'Tutorial', 'Dialogue', 'Quest', 'Mission', 'Achievement', 'Badge',
    'Matchmaking', 'Lobby', 'Server', 'Client', 'Shared', 'Replicated',
  ];
  const found = segments.find((segment) =>
    keywords.some((keyword) => segment.toLowerCase().includes(keyword.toLowerCase())),
  );
  if (found) return found;
  
  // Try to infer from parent service name
  const serviceMap: Record<string, string> = {
    'serverscriptservice': 'Server',
    'starterplayerscripts': 'Client',
    'starterplayerservices': 'Client',
    'replicatedstorage': 'Shared',
    'serverstorage': 'ServerStorage',
    'startergui': 'UI',
    'workplace': 'World',
  };
  const service = segments[0]?.toLowerCase();
  return serviceMap[service] || segments[1] || segments[0] || 'Game';
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
  // Luau type exports
  const typeMatches = source.matchAll(/export\s+type\s+([A-Za-z0-9_]+)/g);
  for (const match of typeMatches) {
    exports.push(`type:${match[1]}`);
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
    [/RunService\./g, 'heartbeat-binding'],
    [/TweenService\./g, 'tween-side-effect'],
    [/HttpService\./g, 'http-request'],
    [/MarketplaceService\./g, 'marketplace-side-effect'],
    [/BadgeService\./g, 'badge-side-effect'],
    [/MessagingService\./g, 'messaging-side-effect'],
    [/BindableEvent/g, 'bindable-event'],
    [/BindableFunction/g, 'bindable-function'],
    [/RemoteEvent/g, 'remote-event'],
    [/RemoteFunction/g, 'remote-function'],
    [/coroutine\./g, 'coroutine-usage'],
  ];
  for (const [pattern, label] of candidates) {
    if (pattern.test(source)) {
      sideEffects.push(label);
    }
  }
  return sideEffects;
}

function detectPatterns(source: string): string[] {
  const patterns: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/(?:^\s*local\s+\w+\s*=\s*\{\})|(?:module\s*=\s*\{\s*\})/m, 'module-table-pattern'],
    [/return\s+(?:module|\w+)$/, 'module-return-pattern'],
    [/OOP\s*\.\s*class|class\s*\(|\.new\s*\(/, 'oop-class-pattern'],
    [/Knit\./, 'knit-framework'],
    [/Promise\./, 'promise-pattern'],
    [/Signal\./, 'signal-pattern'],
    [/Maid\./, 'maid-pattern'],
    [/Component\./, 'component-pattern'],
    [/Roact\./, 'roact-ui'],
    [/Rodux\./, 'rodux-state'],
    [/Replica?Service/, 'replication-service'],
    [/Profile?Service/, 'profile-service'],
    [/Leaderstats?/, 'leaderstats-pattern'],
    [/CharacterAdded/, 'character-lifecycle'],
    [/PlayerAdded/, 'player-lifecycle'],
    [/PlayerRemoving/, 'player-leave-handler'],
    [/Trove\./, 'trove-pattern'],
    [/Janitor\./, 'janitor-pattern'],
    [/TableUtil\./, 'table-util'],
    [/MathUtil\./, 'math-util'],
    [/StringUtil\./, 'string-util'],
    [/Connection\b/, 'connection-tracking'],
    [/Debris\b/, 'debris-usage'],
    [/CollectionService\b/, 'collection-service'],
    [/Tag\b.*Added/, 'tag-lifecycle'],
    [/Raycast|raycast/, 'raycast-usage'],
    [/Region3|region3/, 'region-usage'],
    [/OverlapParams|overlapParams/, 'overlap-usage'],
    [/Touched\b|TouchEnded\b/, 'touch-event'],
    [/Changed\b|GetPropertyChangedSignal/, 'property-change-listener'],
    [/\.AttributeChanged\b|SetAttribute\b/, 'attribute-pattern'],
    [/Bindable\w+\b/, 'bindable-pattern'],
    [/ValueChanged\b|Value\b.*Changed\b/, 'value-object-pattern'],
    [/DataStore|OrderedDataStore\b/, 'datastore-pattern'],
    [/MemoryStore\b/, 'memory-store-pattern'],
    [/Tween\b|Lerp\b/, 'tween-pattern'],
    [/Animation\b|Animator\b/, 'animation-pattern'],
    [/CFrame\.|Vector3\.|Vector2\./, 'math-geometry-pattern'],
    [/Connect\s*\(/, 'event-connection-pattern'],
    [/Disconnect\b|Cleanup\b/, 'cleanup-pattern'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(source)) {
      patterns.push(label);
    }
  }
  return unique(patterns);
}

function detectCustomEvents(source: string): string[] {
  const events: string[] = [];
  // Match custom events like Event:Connect, Signal:Connect, etc.
  const customEventMatches = source.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*Event|Signal|Callback)\b/ug);
  for (const match of customEventMatches) {
    events.push(match[1]);
  }
  return unique(events).slice(0, 10);
}

function detectSpecializedServices(source: string): string[] {
  const services: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/PathfindingService\b/, 'PathfindingService'],
    [/GroupService\b/, 'GroupService'],
    [/TextService\b/, 'TextService'],
    [/LocalizationService\b/, 'LocalizationService'],
    [/SocialService\b/, 'SocialService'],
    [/GamePassService\b/, 'GamePassService'],
    [/UserInputService\b/, 'UserInputService'],
    [/ContextActionService\b/, 'ContextActionService'],
    [/SoundService\b/, 'SoundService'],
    [/Lighting\b/, 'Lighting'],
    [/MaterialService\b/, 'MaterialService'],
    [/Terrain\b/, 'Terrain'],
    [/PolicyService\b/, 'PolicyService'],
    [/StarterGui\b/, 'StarterGui'],
    [/ReplicatedFirst\b/, 'ReplicatedFirst'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(source)) {
      services.push(label);
    }
  }
  return unique(services);
}

function detectAttributesUsage(source: string): string[] {
  const attributes: string[] = [];
  const attrMatches = source.matchAll(/SetAttribute\(["']([^"']+)["']\s*,/g);
  for (const match of attrMatches) {
    attributes.push(match[1]);
  }
  return unique(attributes).slice(0, 12);
}

function analyzeComplexity(source: string): EnhancedScriptSummaryRecord['complexity'] {
  const lines = source.split(/\r?\n/);
  let cyclomatic = 1; // base path
  let maxNesting = 0;
  let currentNesting = 0;
  const functionLengths: number[] = [];
  let functionStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Cyclomatic: count decision points
    if (/\b(if|elseif|while|for|repeat|and|or)\b/.test(trimmed)) {
      cyclomatic += 1;
    }

    // Nesting depth tracking
    const openMatches = (trimmed.match(/\b(do|then|function\b|repeat\b|\{\s*$)/g) || []).length;
    const closeMatches = (trimmed.match(/\b(end|until|\}\s*$)/g) || []).length;
    currentNesting += openMatches - closeMatches;
    maxNesting = Math.max(maxNesting, currentNesting);

    // Function length tracking
    if (/\bfunction\b/.test(trimmed) && functionStart < 0) {
      functionStart = i;
    }
    if (functionStart >= 0 && /\bend\b/.test(trimmed) && currentNesting <= 1) {
      functionLengths.push(i - functionStart + 1);
      functionStart = -1;
    }
  }

  const avgFunctionLength = functionLengths.length > 0
    ? Math.round(functionLengths.reduce((a, b) => a + b, 0) / functionLengths.length)
    : 0;

  return {
    cyclomaticApprox: Math.min(cyclomatic, 50),
    nestingDepth: maxNesting,
    avgFunctionLength,
  };
}

function detectApiSurface(source: string): string[] {
  const apis: string[] = [];
  const localMatches = source.matchAll(/local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g);
  for (const match of localMatches) {
    apis.push(match[1]);
  }
  return unique(apis).slice(0, 20);
}

function detectStateAccess(source: string): string[] {
  const accessors: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/game\.Players\b/, 'Players'],
    [/game\.Workspace\b/, 'Workspace'],
    [/game\.ReplicatedStorage\b/, 'ReplicatedStorage'],
    [/game\.ServerStorage\b/, 'ServerStorage'],
    [/game\.ServerScriptService\b/, 'ServerScriptService'],
    [/game\.StarterGui\b/, 'StarterGui'],
    [/game\.StarterPlayer\b/, 'StarterPlayer'],
    [/game\.Lighting\b/, 'Lighting'],
    [/game\.SoundService\b/, 'SoundService'],
    [/game\.Teams\b/, 'Teams'],
    [/game\.Chat\b/, 'Chat'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(source)) {
      accessors.push(label);
    }
  }
  return unique(accessors);
}

function detectLifecycleHooks(source: string): string[] {
  const hooks: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/PlayerAdded\b/, 'PlayerAdded'],
    [/PlayerRemoving\b/, 'PlayerRemoving'],
    [/CharacterAdded\b/, 'CharacterAdded'],
    [/CharacterRemoving\b/, 'CharacterRemoving'],
    [/ChildAdded\b/, 'ChildAdded'],
    [/ChildRemoved\b/, 'ChildRemoved'],
    [/DescendantAdded\b/, 'DescendantAdded'],
    [/DescendantRemoving\b/, 'DescendantRemoving'],
    [/AncestryChanged\b/, 'AncestryChanged'],
    [/Heartbeat\b|Stepped\b|RenderStepped\b/, 'RunService-Event'],
    [/od\b\(.*init\b/, 'custom-init'],
    [/od\b\(.*start\b/, 'custom-start'],
    [/od\b\(.*stop\b/, 'custom-stop'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(source)) {
      hooks.push(label);
    }
  }
  return unique(hooks);
}

function detectCrossScriptCalls(source: string): string[] {
  const calls: string[] = [];
  const invokeMatches = source.matchAll(/:[A-Za-z_][A-Za-z0-9_]*\s*\(/g);
  for (const match of invokeMatches) {
    calls.push(match[0]);
  }
  const methodMatches = source.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*\b/g);
  for (const match of methodMatches) {
    calls.push(match[0]);
  }
  return unique(calls).slice(0, 15);
}

function detectEventHandlers(source: string): string[] {
  const handlers: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\.MouseButton1Click\b/, 'MouseButton1Click'],
    [/\.MouseButton1Down\b/, 'MouseButton1Down'],
    [/\.MouseButton1Up\b/, 'MouseButton1Up'],
    [/\.MouseButton2Click\b/, 'MouseButton2Click'],
    [/\.Activated\b(?!\s*=)/, 'Activated'],
    [/\.InputBegan\b/, 'InputBegan'],
    [/\.InputEnded\b/, 'InputEnded'],
    [/\.InputChanged\b/, 'InputChanged'],
    [/\.TouchTap\b/, 'TouchTap'],
    [/\.TouchLongPress\b/, 'TouchLongPress'],
    [/\.TouchPinch\b/, 'TouchPinch'],
    [/\.TouchRotate\b/, 'TouchRotate'],
    [/\.TouchSwipe\b/, 'TouchSwipe'],
    [/\.TouchPan\b/, 'TouchPan'],
    [/\.ButtonDown\b/, 'ButtonDown'],
    [/\.ButtonUp\b/, 'ButtonUp'],
    [/\.KeyDown\b/, 'KeyDown'],
    [/\.KeyUp\b/, 'KeyUp'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(source)) {
      handlers.push(label);
    }
  }
  return unique(handlers);
}

export function summarizeScriptSource(input: ScriptSummaryInput): EnhancedScriptSummaryRecord {
  const name = path.basename(input.instancePath.split('.').join(path.sep));
  const subsystem = inferSubsystemFromPath(input.instancePath);
  const dependencies = detectDependencies(input.source);
  const servicesUsed = detectServices(input.source);
  const sideEffects = detectSideEffects(input.source);
  const exports = detectExports(input.source);
  const patterns = detectPatterns(input.source);
  const complexity = analyzeComplexity(input.source);
  const apiSurface = detectApiSurface(input.source);
  const stateAccess = detectStateAccess(input.source);
  const lifecycleHooks = detectLifecycleHooks(input.source);
  const crossScriptCalls = detectCrossScriptCalls(input.source);
  const eventHandlers = detectEventHandlers(input.source);

  const customEvents = detectCustomEvents(input.source);
  const specializedServices = detectSpecializedServices(input.source);
  const attributes = detectAttributesUsage(input.source);

  const purpose = `${name} belongs to the ${subsystem} subsystem`;
  const summaryBits = [
    `${name} script`,
    `subsystem ${subsystem}`,
    servicesUsed.length > 0 ? `services ${servicesUsed.join(', ')}` : '',
    dependencies.length > 0 ? `dependencies ${dependencies.join(', ')}` : '',
    patterns.length > 0 ? `patterns ${patterns.slice(0, 4).join(', ')}` : '',
    lifecycleHooks.length > 0 ? `hooks ${lifecycleHooks.join(', ')}` : '',
    customEvents.length > 0 ? `events ${customEvents.join(', ')}` : '',
    attributes.length > 0 ? `attrs ${attributes.join(', ')}` : '',
  ].filter(Boolean);

  return {
    path: input.instancePath,
    sourceHash: input.sourceHash ?? '',
    summaryShort: summaryBits.join(' | '),
    summaryLong: `${purpose}. Exports ${exports.length} symbol(s), has ${sideEffects.length} notable side-effect pattern(s), complexity approx ${complexity.cyclomaticApprox}, nesting ${complexity.nestingDepth}.`,
    purpose,
    exports,
    dependencies,
    servicesUsed,
    sideEffects,
    subsystem,
    updatedAt: Date.now(),
    patterns,
    complexity,
    apiSurface,
    stateAccess,
    lifecycleHooks,
    crossScriptCalls,
    eventHandlers,
    customEvents,
    specializedServices,
    attributes,
  };
}
