import * as duckdb from '@duckdb/duckdb-wasm';
import './style.css';
import { setupNFCorpus } from './nfcorpus.js';
import { setupMSMarco } from './msmarco.js';
import { setupLLM } from './llm-controller.js';
import { deleteDemoFiles } from './reset.js';

const status = document.querySelector('#status');
const output = document.querySelector('#output');
const buttons = [...document.querySelectorAll('button:not([data-llm-control]):not([data-download-control]):not([data-marco-control])')];
const show = (label, result) => {
  output.textContent = `${label}\n${JSON.stringify(result.toArray().map(row => row.toJSON()),
    (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)}`;
};
let db;
let conn;
let closed = false;
let busy = false;
let marco;

async function download(path, name) {
  let directory = await navigator.storage.getDirectory();
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  const handle = await directory.getFileHandle(parts.at(-1));
  const url = URL.createObjectURL(await handle.getFile());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function run(action, allowClosed = false) {
  if (busy || (closed && !allowClosed)) return;
  busy = true;
  marco?.setBlocked(true);
  buttons.forEach(button => { button.disabled = true; });
  try {
    return await action();
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
    console.error(error);
  } finally {
    busy = false;
    marco?.setBlocked(closed);
    buttons.forEach(button => { button.disabled = closed; });
    document.querySelector('#reload').disabled = false;
    document.querySelector('#reset').disabled = false;
  }
}

const llm = setupLLM();

document.querySelector('#reload').onclick = () => location.reload();
document.querySelector('#orders').onclick = () => run(async () => {
  status.textContent = 'Loading orders and writing the Parquet cache…';
  const tables = await conn.query('SHOW TABLES');
  console.log('Tables before import:', tables.toArray().map(row => row.name));
  await conn.query(`CREATE TABLE IF NOT EXISTS orders AS
    SELECT * FROM 'https://shell.duckdb.org/data/tpch/0_01/parquet/orders.parquet'`);
  await conn.query('CHECKPOINT');
  // Automatic file handling registers OPFS paths in SQL, including subdirectories.
  await conn.query(`COPY (
    SELECT o_orderpriority AS priority, date_trunc('month', o_orderdate) AS month,
           sum(o_totalprice) AS total
    FROM orders GROUP BY ALL
  ) TO 'opfs://cache/monthly_totals.parquet' (FORMAT parquet)`);
  show('Cached monthly totals', await conn.query(
    "SELECT * FROM 'opfs://cache/monthly_totals.parquet' ORDER BY month, priority LIMIT 10"));
  status.textContent = 'Orders persisted; showing the first 10 cached totals.';
});
// Separate experiment: read the persisted table without submitting a remote URL.
document.querySelector('#local-orders').onclick = () => run(async () => {
  const tables = await conn.query('SHOW TABLES');
  if (!tables.toArray().some(row => row.name === 'orders')) {
    status.textContent = 'No saved orders table. Run “Load orders & cache monthly totals” once first.';
    return;
  }
  status.textContent = 'Querying saved orders…';
  show('Monthly totals from the saved orders table', await conn.query(`
    SELECT o_orderpriority AS priority,
           CAST(date_trunc('month', o_orderdate) AS VARCHAR) AS month,
           CAST(sum(o_totalprice) AS VARCHAR) AS total
    FROM orders
    GROUP BY ALL
    ORDER BY month, priority
    LIMIT 10
  `));
  status.textContent = 'Local query complete; showing the first 10 monthly totals.';
});
document.querySelector('#parquet').onclick = () => run(async () => {
  await conn.query(`COPY transactions TO 'opfs://export/transactions.parquet'
    (FORMAT parquet, COMPRESSION zstd)`);
  await download('export/transactions.parquet', 'transactions.parquet');
  status.textContent = 'Parquet download requested.';
});
document.querySelector('#export').onclick = () => run(async () => {
  await conn.query('CHECKPOINT');
  await download('analytics.duckdb', 'analytics.duckdb');
  status.textContent = 'Database download requested.';
});
document.querySelector('#close').onclick = () => run(async () => {
  await marco?.close();
  await conn.query('CHECKPOINT');
  await conn.close();
  await db.terminate();
  closed = true;
  status.textContent = 'Database closed. Reload to reopen it.';
});

document.querySelector('#reset').onclick = () => {
  if (busy) return;
  if (!window.confirm('Delete all tables and indexes in this demo, plus its cached/exported Parquet files in browser storage? Downloaded copies are unaffected. Close other demo tabs first.')) return;
  return run(async () => {
    status.textContent = 'Closing the database and deleting saved demo data…';
    await marco?.close();
    if (!closed) {
      await conn.query('CHECKPOINT');
      await conn.close();
      await db.terminate();
      closed = true;
    }
    output.textContent = '';
    llm.cancel(true);
    document.querySelector('#fts-results').replaceChildren();
    document.querySelector('#fts-status').textContent = 'Database closed for reset.';
    await deleteDemoFiles(await navigator.storage.getDirectory());
    location.reload();
  }, true);
};

async function main() {
  if (!window.isSecureContext || !navigator.storage?.getDirectory) {
    throw new Error('OPFS requires a supported browser on localhost or HTTPS');
  }
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([
    `importScripts(${JSON.stringify(bundle.mainWorker)});`
  ], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
  await db.open({
    path: 'opfs://analytics.duckdb',
    accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
    opfs: { fileHandling: 'auto' },
  });
  conn = await db.connect();
  setupNFCorpus(db, conn, run, llm);
  marco = setupMSMarco(run, llm);
  await conn.query(`CREATE TABLE IF NOT EXISTS transactions (
    id BIGINT, ts TIMESTAMP, merchant VARCHAR, category VARCHAR, amount DECIMAL(10, 2)
  )`);
  // Deliberately repeat the article's id=1: no primary key is declared.
  await conn.query("INSERT INTO transactions VALUES (1, now(), 'Coolblue', 'electronics', 49.95)");
  await conn.query('CHECKPOINT');
  show('Stored transactions', await conn.query(`
  SELECT id, CAST(ts AS VARCHAR) AS inserted_at, merchant, category, CAST(amount AS VARCHAR) AS amount
  FROM transactions
  ORDER BY ts
`));
  status.textContent = 'Ready. Reload: the count should increase by one.';
  buttons.forEach(button => { button.disabled = false; });
}
main().catch(async error => {
  status.textContent = `Startup failed: ${error.message}`;
  console.error(error);
  if (db) await db.terminate().catch(console.error);
});
