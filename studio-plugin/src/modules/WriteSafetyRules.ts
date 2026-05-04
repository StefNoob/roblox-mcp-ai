export interface StudioWriteState {
	isRunning: boolean;
	isEdit: boolean;
}

export function shouldBlockWrite(state: StudioWriteState): boolean {
	return state.isRunning && !state.isEdit;
}

export function describeWriteBlockReason(state: StudioWriteState): string | undefined {
	if (!shouldBlockWrite(state)) {
		return undefined;
	}
	return "Write operations are blocked while Roblox Studio is in Play/Run mode. Stop the session and retry so changes apply to the edit-place instead of the runtime copy.";
}
