const ScriptEditorService = game.GetService("ScriptEditorService");

function arrayCount<T>(items: T[]): number {
	let count = 0;
	for (const _item of items) {
		count += 1;
	}
	return count;
}

function safeCall<T>(func: (...args: never[]) => T, ...args: never[]): T | undefined {
	const [success, result] = pcall(func, ...args);
	if (success) {
		return result;
	} else {
		warn(`MCP Plugin Error: ${result}`);
		return undefined;
	}
}

function getInstancePath(instance: Instance): string {
	if (!instance || instance === game) {
		return "game";
	}

	const pathParts: string[] = [];
	let current: Instance | undefined = instance;

	while (current && current !== game) {
		pathParts.unshift(current.Name);
		current = current.Parent as Instance | undefined;
	}

	return `game.${pathParts.join(".")}`;
}

function getInstanceByPath(path: string): Instance | undefined {
	if (path === "game" || path === "") {
		return game;
	}

	const cleaned = path.gsub("^game%.", "")[0];
	const parts: string[] = [];
	for (const [part] of cleaned.gmatch("[^%.]+")) {
		parts.push(part as string);
	}

	let current: Instance | undefined = game;
	for (const part of parts) {
		current = current?.FindFirstChild(part);
		if (!current) return undefined;
	}

	return current;
}

function splitLines(source: string): LuaTuple<[string[], boolean]> {
	const normalized = ((source ?? "") as string).gsub("\r\n", "\n")[0].gsub("\r", "\n")[0];
	const endsWithNewline = normalized.sub(-1) === "\n";

	const lines: string[] = [];
	let start = 1;

	while (true) {
		const [newlinePos] = string.find(normalized, "\n", start, true);
		if (newlinePos !== undefined) {
			lines.push(string.sub(normalized, start, newlinePos - 1));
			start = newlinePos + 1;
		} else {
			const remainder = string.sub(normalized, start);
			if (remainder !== "" || !endsWithNewline) {
				lines.push(remainder);
			}
			break;
		}
	}

	if (arrayCount(lines) === 0) {
		lines.push("");
	}

	return [lines, endsWithNewline] as unknown as LuaTuple<[string[], boolean]>;
}

function normalizeLineEndings(source: string): string {
	return ((source ?? "") as string).gsub("\r\n", "\n")[0].gsub("\r", "\n")[0];
}

function countLines(source: string): number {
	const normalized = normalizeLineEndings(source);
	if (normalized.size() === 0) {
		return 1;
	}

	let lineCount = 0;
	let searchStart = 1;
	while (true) {
		const [newlinePos] = string.find(normalized, "\n", searchStart, true);
		if (newlinePos === undefined) {
			break;
		}
		lineCount += 1;
		searchStart = newlinePos + 1;
	}

	if (normalized.sub(-1) !== "\n") {
		lineCount += 1;
	}

	return math.max(1, lineCount);
}

function findLineStart(normalized: string, targetLine: number): number | undefined {
	if (targetLine <= 1) {
		return 1;
	}

	let currentLine = 1;
	let searchStart = 1;
	while (currentLine < targetLine) {
		const [newlinePos] = string.find(normalized, "\n", searchStart, true);
		if (newlinePos === undefined) {
			return undefined;
		}
		searchStart = newlinePos + 1;
		currentLine += 1;
	}

	return searchStart;
}

function extractLines(source: string, startLine?: number, endLine?: number) {
	const normalized = normalizeLineEndings(source);
	const totalLineCount = countLines(normalized);
	const hasTrailingNewline = normalized.sub(-1) === "\n";
	const actualStartLine = math.max(1, startLine ?? 1);
	const actualEndLine = math.min(totalLineCount, endLine ?? totalLineCount);

	if (actualStartLine > totalLineCount || actualEndLine < actualStartLine) {
		return {
			source: "",
			lineCount: totalLineCount,
			startLine: actualStartLine,
			endLine: actualEndLine,
		};
	}

	const sliceStart = findLineStart(normalized, actualStartLine);
	if (sliceStart === undefined) {
		return {
			source: "",
			lineCount: totalLineCount,
			startLine: actualStartLine,
			endLine: actualEndLine,
		};
	}

	const afterSliceStart = findLineStart(normalized, actualEndLine + 1);
	let extracted = afterSliceStart !== undefined
		? string.sub(normalized, sliceStart, afterSliceStart - 2)
		: string.sub(normalized, sliceStart);

	if (hasTrailingNewline && actualEndLine === totalLineCount && extracted.sub(-1) !== "\n") {
		extracted += "\n";
	}

	return {
		source: extracted,
		lineCount: totalLineCount,
		startLine: actualStartLine,
		endLine: actualEndLine,
	};
}

function fnv1a32(source: string): string {
	let hash = 0x811c9dc5;
	for (let index = 1; index <= source.size(); index++) {
		const byte = string.byte(source, index)[0] ?? 0;
		hash = bit32.bxor(hash, byte);
		hash = (hash * 0x01000193) % 4294967296;
	}
	return string.format("%08x", hash);
}

function joinLines(lines: string[], hadTrailingNewline: boolean): string {
	let source = lines.join("\n");
	if (hadTrailingNewline && source.sub(-1) !== "\n") {
		source += "\n";
	}
	return source;
}

function readScriptSource(instance: LuaSourceContainer): string {
	const [ok, result] = pcall(() => {
		const doc = ScriptEditorService.FindScriptDocument(instance);
		if (doc) {
			return doc.GetText();
		}
		return undefined;
	});
	if (ok && result) {
		return result;
	}
	return (instance as unknown as { Source: string }).Source;
}

function convertPropertyValue(instance: Instance, propertyName: string, propertyValue: unknown): unknown {
	if (propertyValue === undefined) return undefined;

	const inst = instance as unknown as Record<string, unknown>;

	if (typeIs(propertyValue, "table")) {
		const arr = propertyValue as unknown[];
		const tbl = propertyValue as Record<string, unknown>;

		if (typeIs(arr, "table") && arrayCount(arr as defined[]) > 0) {
			const len = arrayCount(arr as defined[]);

			if (len === 3) {
				const prop = propertyName.lower();
				if (
					prop === "position" || prop === "size" || prop === "orientation" ||
					prop === "velocity" || prop === "angularvelocity"
				) {
					return new Vector3(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
					);
				} else if (prop === "color" || prop === "color3") {
					return new Color3(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
					);
				} else {
					const [success, currentVal] = pcall(() => inst[propertyName]);
					if (success) {
						if (typeOf(currentVal) === "Vector3") {
							return new Vector3(
								(arr[0] as number) ?? 0,
								(arr[1] as number) ?? 0,
								(arr[2] as number) ?? 0,
							);
						} else if (typeOf(currentVal) === "Color3") {
							return new Color3(
								(arr[0] as number) ?? 0,
								(arr[1] as number) ?? 0,
								(arr[2] as number) ?? 0,
							);
						}
					}
				}
			} else if (len === 2) {
				const [success, currentVal] = pcall(() => inst[propertyName]);
				if (success && typeOf(currentVal) === "Vector2") {
					return new Vector2((arr[0] as number) ?? 0, (arr[1] as number) ?? 0);
				}
			} else if (len === 4) {
				const [success, currentVal] = pcall(() => inst[propertyName]);
				if (success && typeOf(currentVal) === "UDim2") {
					return new UDim2(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
						(arr[3] as number) ?? 0,
					);
				}
			}
		}

		if (tbl.X !== undefined || tbl.Y !== undefined || tbl.Z !== undefined) {

			if (typeIs(tbl.X, "table") && typeIs(tbl.Y, "table")) {
				const xTbl = tbl.X as unknown as Record<string, number>;
				const yTbl = tbl.Y as unknown as Record<string, number>;
				return new UDim2(
					xTbl.Scale ?? 0, xTbl.Offset ?? 0,
					yTbl.Scale ?? 0, yTbl.Offset ?? 0,
				);
			}
			return new Vector3(
				(tbl.X as number) ?? 0,
				(tbl.Y as number) ?? 0,
				(tbl.Z as number) ?? 0,
			);
		}

		if (tbl.R !== undefined || tbl.G !== undefined || tbl.B !== undefined) {
			return new Color3(
				(tbl.R as number) ?? 0,
				(tbl.G as number) ?? 0,
				(tbl.B as number) ?? 0,
			);
		}
	}

	if (typeIs(propertyValue, "string")) {
		const [success, currentVal] = pcall(() => inst[propertyName]);
		if (success && typeOf(currentVal) === "EnumItem") {
			const enumItem = currentVal as EnumItem;
			const enumTypeName = tostring(enumItem.EnumType);
			const [enumSuccess, enumVal] = pcall(() => {
				return (Enum as unknown as Record<string, Record<string, EnumItem>>)[enumTypeName][propertyValue];
			});
			if (enumSuccess && enumVal) return enumVal;
		}
		if (propertyName === "BrickColor") {
			return new BrickColor(propertyValue as unknown as number);
		}
		if (propertyValue === "true") return true;
		if (propertyValue === "false") return false;
	}

	return propertyValue;
}

function evaluateFormula(
	formula: string,
	variables: Record<string, unknown> | undefined,
	instance: Instance | undefined,
	index: number,
): LuaTuple<[number, string | undefined]> {
	let value = formula;

	value = value.gsub("index", tostring(index))[0];

	if (instance && instance.IsA("BasePart")) {
		const pos = instance.Position;
		const sz = instance.Size;
		value = value.gsub("Position%.X", tostring(pos.X))[0];
		value = value.gsub("Position%.Y", tostring(pos.Y))[0];
		value = value.gsub("Position%.Z", tostring(pos.Z))[0];
		value = value.gsub("Size%.X", tostring(sz.X))[0];
		value = value.gsub("Size%.Y", tostring(sz.Y))[0];
		value = value.gsub("Size%.Z", tostring(sz.Z))[0];
		value = value.gsub("magnitude", tostring(pos.Magnitude))[0];
	}

	if (variables) {
		for (const [k, v] of pairs(variables)) {
			value = value.gsub(k as string, tostring(v))[0];
		}
	}

	value = value.gsub("sin%(([%d%.%-]+)%)", (x: string) => tostring(math.sin(tonumber(x) ?? 0)))[0];
	value = value.gsub("cos%(([%d%.%-]+)%)", (x: string) => tostring(math.cos(tonumber(x) ?? 0)))[0];
	value = value.gsub("sqrt%(([%d%.%-]+)%)", (x: string) => tostring(math.sqrt(tonumber(x) ?? 0)))[0];
	value = value.gsub("abs%(([%d%.%-]+)%)", (x: string) => tostring(math.abs(tonumber(x) ?? 0)))[0];
	value = value.gsub("floor%(([%d%.%-]+)%)", (x: string) => tostring(math.floor(tonumber(x) ?? 0)))[0];
	value = value.gsub("ceil%(([%d%.%-]+)%)", (x: string) => tostring(math.ceil(tonumber(x) ?? 0)))[0];

	const directResult = tonumber(value);
	if (directResult !== undefined) {
		return [directResult, undefined] as unknown as LuaTuple<[number, string | undefined]>;
	}

	const [success, evalResult] = pcall(() => {
		const num = tonumber(value);
		if (num !== undefined) return num;

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%*%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) * (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%+%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) + (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%-%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) - (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*/%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) {
				const divisor = tonumber(b) ?? 1;
				if (divisor !== 0) return (tonumber(a) ?? 0) / divisor;
			}
		}

		error(`Unsupported formula pattern: ${value}`);
	});

	if (success && typeIs(evalResult, "number")) {
		return [evalResult, undefined] as unknown as LuaTuple<[number, string | undefined]>;
	} else {
		return [index, "Complex formulas not supported - using index value"] as unknown as LuaTuple<[number, string | undefined]>;
	}
}

function compareVersions(v1: string, v2: string): number {
	function parseVersion(v: string): number[] {
		const parts: number[] = [];
		for (const [num] of string.gmatch(v, "%d+")) {
			parts.push(tonumber(num) ?? 0);
		}
		return parts;
	}

	const p1 = parseVersion(v1);
	const p2 = parseVersion(v2);
	const maxLen = math.max(arrayCount(p1), arrayCount(p2));
	for (let i = 0; i < maxLen; i++) {
		const n1 = p1[i] ?? 0;
		const n2 = p2[i] ?? 0;
		if (n1 < n2) return -1;
		if (n1 > n2) return 1;
	}
	return 0;
}

export = {
	safeCall,
	getInstancePath,
	getInstanceByPath,
	splitLines,
	normalizeLineEndings,
	countLines,
	extractLines,
	fnv1a32,
	joinLines,
	readScriptSource,
	convertPropertyValue,
	evaluateFormula,
	compareVersions,
};
