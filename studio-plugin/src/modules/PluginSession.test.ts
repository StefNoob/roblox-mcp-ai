import { createPluginSessionId } from "./PluginSession";

describe("createPluginSessionId", () => {
	it("uses generated guid when available", () => {
		const sessionId = createPluginSessionId(() => "guid-123");
		expect(sessionId).toBe("studio-guid-123");
	});

	it("falls back to a timestamp-based id when guid generation is unavailable", () => {
		const sessionId = createPluginSessionId(() => undefined, () => "1714470000000");
		expect(sessionId).toBe("studio-fallback-1714470000000");
	});
});
