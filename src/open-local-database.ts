import { DuckDBAccessMode, DuckDBDataProtocol, type AsyncDuckDB } from '@duckdb/duckdb-wasm';

// Register even empty files: the automatic OPFS preparation path skips them.
// Keeping the database and WAL on FSACCESS allows the first transaction to persist.
export async function openLocalDatabase(
  db: Pick<AsyncDuckDB, 'registerFileHandle' | 'open'>,
  root: FileSystemDirectoryHandle,
) {
  const path = 'opfs://analytics.duckdb';
  for (const name of ['analytics.duckdb', 'analytics.duckdb.wal']) {
    const handle = await root.getFileHandle(name, { create: true });
    await db.registerFileHandle(`opfs://${name}`, handle, DuckDBDataProtocol.BROWSER_FSACCESS, true);
  }
  await db.open({ path, accessMode: DuckDBAccessMode.READ_WRITE, opfs: { fileHandling: 'auto' } });
}
