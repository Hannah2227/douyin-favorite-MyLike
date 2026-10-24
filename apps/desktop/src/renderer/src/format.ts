export function formatBytes(bytes: number): string {
  if (bytes > 0 && bytes < 10_000) return '<0.01 MB'
  return `${(Math.max(0, bytes) / 1_000_000).toFixed(2)} MB`
}
