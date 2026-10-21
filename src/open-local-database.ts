import { DuckDBAccessMode, DuckDBDataProtocol, type AsyncDuckDB } from '@duckdb/duckdb-wasm';
import { DatabaseInUseError } from './database-lock.ts';
import { errorMessage, errorName } from './errors.ts';

// Register even empty files: the automatic OPFS preparation path skips them.
// Keeping the database and WAL on FSACCESS allows the first transaction to persist.
export async function openLocalDatabase(
  db: Pick<AsyncDuckDB, 'registerFileHandle' | 'open'>,
  root: FileSystemDirectoryHandle,
) {
  try {
    const path = 'opfs://analytics.duckdb';
    for (const name of ['analytics.duckdb', 'analytics.duckdb.wal']) {
      const handle = await root.getFileHandle(name, { create: true });
      await db.registerFileHandle(`opfs://${name}`, handle, DuckDBDataProtocol.BROWSER_FSACCESS, true);
    }
    await db.open({ path, accessMode: DuckDBAccessMode.READ_WRITE, opfs: { fileHandling: 'auto' } });
  } catch (error) {
    // Older tabs may not participate in Web Locks. DuckDB also serializes
    // worker exceptions into plain Errors, so recognize the OPFS message.
    const message = errorMessage(error);
    if (errorName(error) === 'NoModificationAllowedError' || message.includes('NoModificationAllowedError') ||
      (message.includes('createSyncAccessHandle') && /another open access handle|writable stream associated with the same file/i.test(message))) {
      throw new DatabaseInUseError(false, { cause: error });
    }
    throw error;
  }
}
