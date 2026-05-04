import { HttpService } from "@rbxts/services";

type FallbackClock = () => string;
type GuidGenerator = () => string | undefined;

function defaultFallbackClock(): string {
	return `${tostring(math.floor(tick() * 1000))}-${tostring(math.random(0, 999999))}`;
}

function defaultGuidGenerator(): string | undefined {
	try {
		return HttpService.GenerateGUID(false);
	} catch {
		return undefined;
	}
}

export function createPluginSessionId(
	generateGuid: GuidGenerator = defaultGuidGenerator,
	fallbackClock: FallbackClock = defaultFallbackClock,
): string {
	const guid = generateGuid();
	if (guid && guid !== "") {
		return `studio-${guid}`;
	}

	return `studio-fallback-${fallbackClock()}`;
}
