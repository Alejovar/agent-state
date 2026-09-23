/** node:sqlite is available without a flag from 22.13 (22.x line) and 23.4 (23.x line). */
export function nodeSupported(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major >= 24;
}
