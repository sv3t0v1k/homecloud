const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;

type ParsedVersion = { major: number; minor: number; patch: number; beta: number | null };

export function parseVersion(tag: string): ParsedVersion | null {
  const match = VERSION.exec(tag);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

export function isVersion(tag: string): boolean {
  return parseVersion(tag) !== null;
}

export function isNewerVersion(candidate: string, installed: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // Одна и та же X.Y.Z: стабильная версия новее любой беты; beta.N+1 новее beta.N.
  if (a.beta === null) return b.beta !== null;
  if (b.beta === null) return false;
  return a.beta > b.beta;
}

export async function withRetry<T>(task: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw last;
}
