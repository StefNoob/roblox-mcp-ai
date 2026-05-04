export function shouldRunMcpInStdioMode({
	forceStdio = false,
	forceManaged = false,
	stdinIsTTY = false,
	stdoutIsTTY = false,
} = {}) {
	if (forceManaged) {
		return false;
	}

	if (forceStdio) {
		return true;
	}

	return !stdinIsTTY || !stdoutIsTTY;
}
