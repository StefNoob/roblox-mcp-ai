export type LuauDiagnosticSeverity = 'error' | 'warning' | 'info';

export type ParsedLuauDiagnostic = {
  filePath: string;
  line: number;
  column: number;
  severity: LuauDiagnosticSeverity;
  code: string | null;
  message: string;
  raw: string;
};

export function parseLuauDiagnostics(raw: string): ParsedLuauDiagnostic[] {
  const diagnostics: ParsedLuauDiagnostic[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const parsed = parseDiagnosticLine(line);
    if (parsed) {
      diagnostics.push(parsed);
    }
  }

  return diagnostics;
}

function parseDiagnosticLine(line: string): ParsedLuauDiagnostic | null {
  const patterns = [
    /^(?<file>.+)\((?<line>\d+),(?<column>\d+)\):\s*(?:(?<code>[A-Za-z][\w-]*)\s*:\s*)?(?<message>.+)$/u,
    /^(?<file>.+):(?<line>\d+):(?<column>\d+):\s*(?:(?<code>[A-Za-z][\w-]*)\s*:\s*)?(?<message>.+)$/u,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match?.groups) {
      continue;
    }
    const filePath = match.groups.file?.trim();
    const message = match.groups.message?.trim();
    if (!filePath || !message) {
      continue;
    }
    const code = match.groups.code?.trim() || null;
    return {
      filePath,
      line: Number(match.groups.line),
      column: Number(match.groups.column),
      severity: inferDiagnosticSeverity(code, message),
      code,
      message,
      raw: line,
    };
  }

  return null;
}

function inferDiagnosticSeverity(code: string | null, message: string): LuauDiagnosticSeverity {
  const text = `${code || ''} ${message}`.toLowerCase();
  if (text.includes('warning') || text.includes('unused')) {
    return 'warning';
  }
  if (text.includes('info') || text.includes('hint')) {
    return 'info';
  }
  return 'error';
}

export type FunctionReplacementResult = {
  source: string;
  startLine: number;
  endLine: number;
};

export function replaceLuauFunctionBlock(
  source: string,
  functionName: string,
  newFunctionContent: string,
): FunctionReplacementResult {
  const lines = source.split('\n');
  const matcher = createFunctionMatcher(functionName);
  let startIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (matcher.test(lines[i])) {
      startIndex = i;
      break;
    }
  }

  if (startIndex < 0) {
    throw new Error(`Function not found: ${functionName}`);
  }

  let depth = 0;
  let endIndex = -1;
  for (let i = startIndex; i < lines.length; i += 1) {
    const sanitized = sanitizeLuauLine(lines[i]);
    depth += countBlockOpens(sanitized);
    depth -= countBlockCloses(sanitized);
    if (depth <= 0) {
      endIndex = i;
      break;
    }
  }

  if (endIndex < startIndex) {
    throw new Error(`Could not determine function boundary for ${functionName}`);
  }

  const replacementLines = newFunctionContent.split('\n');
  lines.splice(startIndex, endIndex - startIndex + 1, ...replacementLines);

  return {
    source: lines.join('\n'),
    startLine: startIndex + 1,
    endLine: endIndex + 1,
  };
}

function createFunctionMatcher(functionName: string) {
  const escaped = escapeRegExp(functionName);
  return new RegExp(
    `^\\s*(?:local\\s+)?function\\s+${escaped}\\s*\\(`,
    'u',
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeLuauLine(line: string) {
  return line
    .replace(/--.*$/u, '')
    .replace(/'[^']*'/gu, "''")
    .replace(/"[^"]*"/gu, '""');
}

function countBlockOpens(line: string) {
  let count = 0;
  count += (line.match(/\bfunction\b/gu) || []).length;
  if (/\brepeat\b/u.test(line)) count += 1;
  if (/\bwhile\b.*\bdo\b/u.test(line)) count += 1;
  if (/\bfor\b.*\bdo\b/u.test(line)) count += 1;
  if (/^\s*if\b.*\bthen\b/u.test(line)) count += 1;
  if (/^\s*do\b/u.test(line)) count += 1;
  return count;
}

function countBlockCloses(line: string) {
  let count = 0;
  count += (line.match(/\bend\b/gu) || []).length;
  if (/\buntil\b/u.test(line)) count += 1;
  return count;
}

export type NumericLeafSummary = {
  min: number;
  max: number;
  avg: number;
  latest: number;
};

export function summarizePerformanceSamples(samples: Record<string, unknown>[]) {
  const buckets = new Map<string, number[]>();

  for (const sample of samples) {
    for (const [path, value] of flattenNumericLeaves(sample)) {
      const bucket = buckets.get(path) || [];
      bucket.push(value);
      buckets.set(path, bucket);
    }
  }

  const summary: Record<string, NumericLeafSummary> = {};
  for (const [path, values] of buckets) {
    const total = values.reduce((sum, value) => sum + value, 0);
    summary[path] = {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round((total / values.length) * 100) / 100,
      latest: values[values.length - 1],
    };
  }

  return summary;
}

function flattenNumericLeaves(
  value: unknown,
  prefix: string = '',
): Array<[string, number]> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return prefix ? [[prefix, value]] : [];
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const result: Array<[string, number]> = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    result.push(...flattenNumericLeaves(child, nextPrefix));
  }
  return result;
}
