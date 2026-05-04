import { getServerHostFallbacks, resolveServerHost } from "../server-config";

describe("resolveServerHost", () => {
	test("defaults to localhost so plugin URL and server bind target stay aligned", () => {
		expect(resolveServerHost(undefined)).toBe("localhost");
	});

	test("preserves an explicit host override", () => {
		expect(resolveServerHost("127.0.0.1")).toBe("127.0.0.1");
	});

	test("adds IPv4 loopback fallback on Windows when localhost is the default host", () => {
		expect(getServerHostFallbacks("localhost", "win32")).toEqual(["127.0.0.1"]);
	});

	test("does not add fallback for non-Windows platforms or explicit hosts", () => {
		expect(getServerHostFallbacks("localhost", "linux")).toEqual([]);
		expect(getServerHostFallbacks("127.0.0.1", "win32")).toEqual([]);
	});
});
