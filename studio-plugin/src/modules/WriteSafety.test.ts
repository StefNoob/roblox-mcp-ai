import { describeWriteBlockReason, shouldBlockWrite } from "./WriteSafetyRules";

describe("WriteSafety", () => {
	test("allows writes while Studio is in edit mode", () => {
		expect(shouldBlockWrite({ isRunning: false, isEdit: true })).toBe(false);
		expect(describeWriteBlockReason({ isRunning: false, isEdit: true })).toBeUndefined();
	});

	test("blocks writes while a play or run session is active", () => {
		expect(shouldBlockWrite({ isRunning: true, isEdit: false })).toBe(true);
		expect(describeWriteBlockReason({ isRunning: true, isEdit: false })).toContain("Play/Run");
	});
});
