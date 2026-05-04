export function shouldSuspendStructureMap(state: { isRunning: boolean; isEdit: boolean }): boolean {
	return state.isRunning && !state.isEdit;
}
