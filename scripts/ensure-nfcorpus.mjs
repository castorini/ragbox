import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const dataset = resolve('public/data/nfcorpus.jsonl');
try {
  await access(dataset);
  console.log('Using prepared NFCorpus data.');
  process.exit(0);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const archiveUrl = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip';
const directory = await mkdtemp(join(tmpdir(), 'ragbox-nfcorpus-'));
try {
  console.log('Downloading NFCorpus for the single-file build…');
  const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`NFCorpus download failed: HTTP ${response.status}`);
  const archive = join(directory, 'nfcorpus.zip');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  await promisify(execFile)('unzip', ['-q', archive, 'nfcorpus/corpus.jsonl', '-d', directory]);
  await promisify(execFile)(process.execPath, [resolve('scripts/prepare-nfcorpus.mjs'),
    join(directory, 'nfcorpus/corpus.jsonl')]);
  console.log('NFCorpus data is ready.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
