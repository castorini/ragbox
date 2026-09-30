import { errorName } from './boundaries.ts';

export const DEMO_FILES = [
  'analytics.duckdb.wal',
  'analytics.duckdb.wal.checkpoint',
  'analytics.duckdb.wal.recovery',
  'analytics.duckdb',
  'msmarco-prebuilt.duckdb',
  'cache/monthly_totals.parquet',
  'export/transactions.parquet',
] as const;

export async function deleteDemoFile(root: FileSystemDirectoryHandle, path: string) {
  if (!DEMO_FILES.some(name => name === path)) throw new Error('This file is not owned by ragbox.');
  const parts = path.split('/');
  try {
    let directory = root;
    for (const folder of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(folder);
    await directory.removeEntry(parts.at(-1)!);
  } catch (error) {
    if (errorName(error) !== 'NotFoundError') throw error;
  }
}

// Delete only files owned by this demo, not other applications on the origin.
export async function deleteDemoFiles(root: FileSystemDirectoryHandle) {
  for (const path of DEMO_FILES) await deleteDemoFile(root, path);
}
