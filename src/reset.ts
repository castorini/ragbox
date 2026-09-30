import { errorName } from './boundaries.ts';

// Delete only files owned by this demo, not other applications on the origin.
export async function deleteDemoFiles(root: FileSystemDirectoryHandle) {
  async function remove(directory: FileSystemDirectoryHandle, name: string) {
    try { await directory.removeEntry(name); }
    catch (error) { if (errorName(error) !== 'NotFoundError') throw error; }
  }
  for (const name of [
    'analytics.duckdb.wal',
    'analytics.duckdb.wal.checkpoint',
    'analytics.duckdb.wal.recovery',
    'analytics.duckdb',
    'msmarco-prebuilt.duckdb',
  ]) await remove(root, name);
  for (const [folder, name] of [
    ['cache', 'monthly_totals.parquet'],
    ['export', 'transactions.parquet'],
  ]) {
    let directory;
    try { directory = await root.getDirectoryHandle(folder); }
    catch (error) {
      if (errorName(error) === 'NotFoundError') continue;
      throw error;
    }
    await remove(directory, name);
  }
}
