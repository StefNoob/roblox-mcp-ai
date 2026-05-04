import Utils from "../Utils";
import StructureMap from "../StructureMap";

const ChangeHistoryService = game.GetService("ChangeHistoryService");
const ScriptEditorService = game.GetService("ScriptEditorService");

const {
	getInstancePath,
	getInstanceByPath,
	readScriptSource,
	splitLines,
	joinLines,
	extractLines,
	countLines,
	fnv1a32,
} = Utils;

function getScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number | undefined;
	const endLine = requestData.endLine as number | undefined;
	const fullSourceRequested = requestData.fullSource === true;
	const includeNumberedSource = requestData.includeNumberedSource !== false;

	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const fullSource = readScriptSource(instance);
		const fullSourceLineCount = countLines(fullSource);

		let sourceToReturn = fullSource;
		let returnedStartLine = 1;
		let returnedEndLine = fullSourceLineCount;

		if (startLine !== undefined || endLine !== undefined) {
			const extracted = extractLines(fullSource, startLine, endLine);
			sourceToReturn = extracted.source;
			returnedStartLine = extracted.startLine;
			returnedEndLine = extracted.endLine;
		}

		const resp: Record<string, unknown> = {
			instancePath,
			className: instance.ClassName,
			name: instance.Name,
			source: sourceToReturn,
			sourceLength: fullSource.size(),
			lineCount: fullSourceLineCount,
			startLine: returnedStartLine,
			endLine: returnedEndLine,
			isPartial: startLine !== undefined || endLine !== undefined,
			truncated: false,
		};

		if (includeNumberedSource) {
			const numberedLines: string[] = [];
			const [linesToNumber] = splitLines(sourceToReturn);
			const lineOffset = returnedStartLine - 1;
			for (let i = 0; i < linesToNumber.size(); i++) {
				numberedLines.push(`${i + 1 + lineOffset}: ${linesToNumber[i]}`);
			}
			resp.numberedSource = numberedLines.join("\n");
		}

		if (!fullSourceRequested && startLine === undefined && endLine === undefined && fullSource.size() > 50000) {
			const maxLines = math.min(1000, fullSourceLineCount);
			const extracted = extractLines(fullSource, 1, maxLines);
			resp.source = extracted.source;
			if (includeNumberedSource) {
				const [truncatedLines] = splitLines(extracted.source);
				const truncatedNumberedLines: string[] = [];
				for (let i = 0; i < truncatedLines.size(); i++) {
					truncatedNumberedLines.push(`${i + 1}: ${truncatedLines[i]}`);
				}
				resp.numberedSource = truncatedNumberedLines.join("\n");
			}
			resp.truncated = true;
			resp.endLine = maxLines;
			resp.note = "Script truncated to first 1000 lines. Use startLine/endLine parameters to read specific sections.";
		}

		if (instance.IsA("BaseScript")) {
			resp.enabled = instance.Enabled;
		}
		StructureMap.touchScriptSummary(instancePath, fnv1a32(fullSource));
		return resp;
	});

	if (success) {
		return result;
	} else {
		return { error: `Failed to get script source: ${result}` };
	}
}

function getScriptMetadata(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;

	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
		const sourceHash = fnv1a32(source);
		StructureMap.touchScriptSummary(instancePath, sourceHash);
		return {
			instancePath,
			className: instance.ClassName,
			name: instance.Name,
			sourceLength: source.size(),
			lineCount: countLines(source),
			sourceHash,
		};
	});

	if (success) {
		return result;
	}

	return { error: `Failed to get script metadata: ${result}` };
}

function setScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const newSource = requestData.source as string;

	if (!instancePath || newSource === undefined) {
		return { error: "Instance path and source are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const sourceToSet = newSource;

	const [updateSuccess, updateResult] = pcall(() => {
		const oldSourceLength = readScriptSource(instance).size();

		ScriptEditorService.UpdateSourceAsync(instance, () => sourceToSet);
		ChangeHistoryService.SetWaypoint(`Set script source: ${instance.Name}`);

		return {
			success: true, instancePath,
			oldSourceLength, newSourceLength: sourceToSet.size(),
			method: "UpdateSourceAsync",
			message: "Script source updated successfully (editor-safe)",
		};
	});

	if (updateSuccess) {
		StructureMap.markDirty("set-script-source");
		return updateResult;
	}

	const [directSuccess, directResult] = pcall(() => {
		const oldSource = (instance as unknown as { Source: string }).Source;
		(instance as unknown as { Source: string }).Source = sourceToSet;
		ChangeHistoryService.SetWaypoint(`Set script source: ${instance.Name}`);

		return {
			success: true, instancePath,
			oldSourceLength: oldSource.size(), newSourceLength: sourceToSet.size(),
			method: "direct",
			message: "Script source updated successfully (direct assignment)",
		};
	});

	if (directSuccess) {
		StructureMap.markDirty("set-script-source");
		return directResult;
	}

	return {
		error: `Failed to set script source safely. UpdateSourceAsync failed: ${updateResult}. Direct assignment failed: ${directResult}`,
	};
}

function editScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number;
	const endLine = requestData.endLine as number;
	let newContent = requestData.newContent as string;

	if (!instancePath || !startLine || !endLine || newContent === undefined) {
		return { error: "Instance path, startLine, endLine, and newContent are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (startLine < 1 || startLine > totalLines) error(`startLine out of range (1-${totalLines})`);
		if (endLine < startLine || endLine > totalLines) error(`endLine out of range (${startLine}-${totalLines})`);

		const [newLines] = splitLines(newContent);
		const resultLines: string[] = [];

		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);
		ChangeHistoryService.SetWaypoint(`Edit script lines ${startLine}-${endLine}: ${instance.Name}`);

		return {
			success: true, instancePath,
			editedLines: { startLine, endLine },
			linesRemoved: endLine - startLine + 1,
			linesAdded: newLines.size(),
			newLineCount: resultLines.size(),
			message: "Script lines edited successfully",
		};
	});

	if (success) {
		StructureMap.markDirty("edit-script-lines");
		return result;
	}
	return { error: `Failed to edit script lines: ${result}` };
}

function insertScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const afterLine = (requestData.afterLine as number) ?? 0;
	let newContent = requestData.newContent as string;

	if (!instancePath || newContent === undefined) {
		return { error: "Instance path and newContent are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (afterLine < 0 || afterLine > totalLines) error(`afterLine out of range (0-${totalLines})`);

		const [newLines] = splitLines(newContent);
		const resultLines: string[] = [];

		for (let i = 0; i < afterLine; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = afterLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);
		ChangeHistoryService.SetWaypoint(`Insert script lines after line ${afterLine}: ${instance.Name}`);

		return {
			success: true, instancePath,
			insertedAfterLine: afterLine,
			linesInserted: newLines.size(),
			newLineCount: resultLines.size(),
			message: "Script lines inserted successfully",
		};
	});

	if (success) {
		StructureMap.markDirty("insert-script-lines");
		return result;
	}
	return { error: `Failed to insert script lines: ${result}` };
}

function deleteScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number;
	const endLine = requestData.endLine as number;

	if (!instancePath || !startLine || !endLine) {
		return { error: "Instance path, startLine, and endLine are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(readScriptSource(instance));
		const totalLines = lines.size();

		if (startLine < 1 || startLine > totalLines) error(`startLine out of range (1-${totalLines})`);
		if (endLine < startLine || endLine > totalLines) error(`endLine out of range (${startLine}-${totalLines})`);

		const resultLines: string[] = [];
		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		ScriptEditorService.UpdateSourceAsync(instance, () => newSource);
		ChangeHistoryService.SetWaypoint(`Delete script lines ${startLine}-${endLine}: ${instance.Name}`);

		return {
			success: true, instancePath,
			deletedLines: { startLine, endLine },
			linesDeleted: endLine - startLine + 1,
			newLineCount: resultLines.size(),
			message: "Script lines deleted successfully",
		};
	});

	if (success) {
		StructureMap.markDirty("delete-script-lines");
		return result;
	}
	return { error: `Failed to delete script lines: ${result}` };
}

export = {
	getScriptSource,
	getScriptMetadata,
	setScriptSource,
	editScriptLines,
	insertScriptLines,
	deleteScriptLines,
};
