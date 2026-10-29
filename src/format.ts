export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(1)} ${units[unit]}`;
}

// One wording for every download in the app: "Downloading <name>: 1.00 / 3.35 GB (30%)".
export function downloadProgressText(name: string, received: number, total: number): string {
  const percent = total > 0 ? Math.min(100, received / total * 100) : 0;
  return `Downloading ${name}: ${(received / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB (${percent.toFixed(0)}%)`;
}
