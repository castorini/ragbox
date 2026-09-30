import * as duckdb from '@duckdb/duckdb-wasm';
import { rowsAs } from './boundaries.ts';
export const PREBUILT_NAME = 'msmarco-prebuilt.duckdb';

// Copy via streams directly into OPFS, without buffering a multi-GB file in JS.
export async function copyPrebuilt(file: Pick<Blob, 'stream'>, root: FileSystemDirectoryHandle) {
  const handle = await root.getFileHandle(PREBUILT_NAME, { create: true });
  const writable = await handle.createWritable();
  await file.stream().pipeTo(writable);
}

export async function openPrebuilt() {
  // Check existence: do not silently create an empty database on reopen.
  const root = await navigator.storage.getDirectory();
  await root.getFileHandle(PREBUILT_NAME);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const url = URL.createObjectURL(new Blob([
    `importScripts(${JSON.stringify(bundle.mainWorker)});`,
  ], { type: 'text/javascript' }));
  const worker = new Worker(url);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  let conn: duckdb.AsyncDuckDBConnection | undefined;
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.open({ path: `opfs://${PREBUILT_NAME}`, accessMode: duckdb.DuckDBAccessMode.READ_ONLY });
    conn = await db.connect();
    await conn.query('INSTALL fts; LOAD fts');
    // Bind and execute the actual saved retrieval macro to validate the artifact.
    await conn.query(`SELECT fts_main_msmarco.match_bm25(id, 'corporation') AS score
      FROM msmarco LIMIT 1`);
    const count = Number(rowsAs<{ n: number | bigint }>(await conn.query('SELECT count(*) AS n FROM msmarco'))[0].n);
    const activeConn = conn;
    return { conn, count, async close() {
      try { await activeConn.close(); } finally { await db.terminate(); }
    } };
  } catch (error) {
    if (conn) await conn.close().catch(() => {});
    await db.terminate().catch(() => {});
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
