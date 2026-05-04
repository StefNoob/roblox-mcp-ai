import { describePollFailure, isHandshakeHttpSuccess, isPollHttpSuccess } from "./PollResult";

beforeAll(() => {
	(globalThis as { typeOf?: (value: unknown) => string }).typeOf = (value: unknown) => {
		if (value === undefined || value === null) return "nil";
		if (typeof value === "number") return "number";
		if (typeof value === "string") return "string";
		if (typeof value === "boolean") return "boolean";
		if (typeof value === "object") return "table";
		return typeof value;
	};
});

describe("isPollHttpSuccess", () => {
	it("treats explicit Roblox success as success", () => {
		expect(isPollHttpSuccess({ Success: true, StatusCode: 200 })).toBe(true);
	});

	it("treats 200 responses as success even when Success is missing", () => {
		expect(isPollHttpSuccess({ StatusCode: 200 })).toBe(true);
	});

	it("treats 503 responses as soft success for waiting state", () => {
		expect(isPollHttpSuccess({ Success: false, StatusCode: 503 })).toBe(true);
	});

	it("treats transport failures as failure", () => {
		expect(isPollHttpSuccess({ Success: false, StatusCode: 0 })).toBe(false);
	});
});

describe("describePollFailure", () => {
	it("reports pcall transport errors", () => {
		expect(describePollFailure(false, "HttpError: DnsResolve")).toBe("transport error: HttpError: DnsResolve");
	});

	it("reports HTTP status details", () => {
		expect(
			describePollFailure(true, {
				Success: false,
				StatusCode: 403,
				StatusMessage: "Forbidden",
			}),
		).toBe("http 403 Forbidden");
	});

	it("reports soft-wait HTTP status details", () => {
		expect(
			describePollFailure(true, {
				Success: false,
				StatusCode: 503,
				StatusMessage: "Service Unavailable",
			}),
		).toBe("http 503 Service Unavailable");
	});

	it("falls back to a generic message", () => {
		expect(describePollFailure(true, {})).toBe("unknown polling failure");
	});
});

describe("isHandshakeHttpSuccess", () => {
	it("accepts 2xx handshake responses", () => {
		expect(isHandshakeHttpSuccess({ Success: true, StatusCode: 200 })).toBe(true);
	});

	it("rejects 503 waiting responses for handshake", () => {
		expect(isHandshakeHttpSuccess({ Success: false, StatusCode: 503 })).toBe(false);
	});

	it("rejects 403 forbidden responses for handshake", () => {
		expect(isHandshakeHttpSuccess({ Success: false, StatusCode: 403 })).toBe(false);
	});
});
