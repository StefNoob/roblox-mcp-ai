import { getActivationOptions } from "./ActivationMode";

describe("getActivationOptions", () => {
	it("opens the widget for manual activation", () => {
		expect(getActivationOptions("manual")).toEqual({
			showUi: true,
			sendImmediatePing: true,
			bootstrapRetryCount: 2,
			bootstrapRetryDelaySeconds: 0.5,
		});
	});

	it("keeps the widget hidden for startup auto-connect", () => {
		expect(getActivationOptions("startup")).toEqual({
			showUi: false,
			sendImmediatePing: true,
			bootstrapRetryCount: 5,
			bootstrapRetryDelaySeconds: 1,
		});
	});
});
