import { RunService } from "@rbxts/services";
import { type StudioWriteState, describeWriteBlockReason, shouldBlockWrite } from "./WriteSafetyRules";

export function getStudioWriteState(): StudioWriteState {
	let isRunning = false;
	let isEdit = false;

	try {
		isRunning = RunService.IsRunning() === true;
	} catch {
		isRunning = false;
	}

	try {
		isEdit = RunService.IsEdit() === true;
	} catch {
		isEdit = false;
	}

	if (isRunning && isEdit) {
		isEdit = false;
	}

	if (isRunning) {
		isRunning = true;
	}

	return {
		isRunning,
		isEdit,
	};
}

export { describeWriteBlockReason, shouldBlockWrite };
