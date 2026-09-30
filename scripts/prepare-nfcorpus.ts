import { readFile, mkdir, writeFile } from 'node:fs/promises';
type SourceRow = { _id: string; title: string; text: string };

const source = process.argv[2];
if (!source) throw new Error('Usage: npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl');
const text = await readFile(source, 'utf8');
const rows = text.trim().split(/\r?\n/).map(line => JSON.parse(line) as SourceRow);
if (rows.length !== 3633 || new Set(rows.map(row => row._id)).size !== rows.length ||
    rows.some(row => typeof row._id !== 'string' || typeof row.title !== 'string' || typeof row.text !== 'string')) {
  throw new Error('Expected 3,633 unique NFCorpus documents with _id, title, and text fields.');
}
const directory = new URL('../public/data/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('nfcorpus.jsonl', directory), rows.map(row => JSON.stringify({
  id: row._id, title: row.title, text: row.text,
})).join('\n') + '\n');
console.log(`Prepared ${rows.length} documents for browser import.`);
