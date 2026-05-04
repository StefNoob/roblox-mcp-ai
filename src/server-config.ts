export function resolveServerHost(rawHost: string | undefined): string {
  const candidate = rawHost?.trim();
  if (!candidate) {
    return 'localhost';
  }

  return candidate;
}

export function getServerHostFallbacks(
  host: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') {
    return [];
  }

  if (host !== 'localhost') {
    return [];
  }

  return ['127.0.0.1'];
}
