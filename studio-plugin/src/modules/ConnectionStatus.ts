import { Connection } from "../types";

export type ConnectionPhase = "disconnected" | "error" | "connected" | "waiting" | "retry" | "connecting";

export function deriveConnectionPhase(conn: Connection): ConnectionPhase {
	if (!conn.isActive) {
		return "disconnected";
	}
	if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) {
		return "error";
	}
	if (conn.lastHttpOk && conn.lastMcpConnected) {
		return "connected";
	}
	if (conn.lastHttpOk) {
		return "waiting";
	}
	if (conn.consecutiveFailures > 5) {
		return "retry";
	}
	return "connecting";
}
