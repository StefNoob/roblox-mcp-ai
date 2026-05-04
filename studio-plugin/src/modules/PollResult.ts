type PollHttpResult = {
	Success?: boolean;
	StatusCode?: number;
	StatusMessage?: string;
};

declare function typeOf(value: unknown): string;

function isSuccessfulStatusCode(statusCode: number, allowSoftWaitingStatus = false): boolean {
	return (
		(statusCode >= 200 && statusCode < 300) ||
		statusCode === 304 ||
		(allowSoftWaitingStatus && statusCode === 503)
	);
}

export function isPollHttpSuccess(result: PollHttpResult): boolean {
	if (result.Success === true) {
		return true;
	}

	const statusCode = result.StatusCode;
	if (typeOf(statusCode) === "number") {
		const numericStatusCode = statusCode as number;
		return isSuccessfulStatusCode(numericStatusCode, true);
	}

	return false;
}

export function isHandshakeHttpSuccess(result: PollHttpResult): boolean {
	if (result.Success === true) {
		return true;
	}

	const statusCode = result.StatusCode;
	if (typeOf(statusCode) === "number") {
		return isSuccessfulStatusCode(statusCode as number, false);
	}

	return false;
}

export function describePollFailure(success: boolean, result: unknown): string {
	if (!success) {
		return `transport error: ${result}`;
	}

	if (result !== undefined && typeOf(result) === "table") {
		const pollResult = result as PollHttpResult;
		const statusCode = pollResult.StatusCode;
		const statusMessage = pollResult.StatusMessage;
		if (typeOf(statusCode) === "number") {
			if (typeOf(statusMessage) === "string" && statusMessage !== "") {
				return `http ${statusCode} ${statusMessage}`;
			}
			return `http ${statusCode}`;
		}
	}

	return "unknown polling failure";
}
