export function resolveServerHost(rawHost: string | undefined): string {
  const candidate = rawHost?.trim();
  if (!candidate) {
    return '127.0.0.1';
  }

  return candidate;
}
