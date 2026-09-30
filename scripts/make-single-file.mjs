import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('dist-single');
const htmlPath = resolve(output, 'index.html');
const datasetPath = resolve('public/data/nfcorpus.jsonl');
let html = await readFile(htmlPath, 'utf8');
const dataset = await readFile(datasetPath);

const script = html.match(/<script type="module" crossorigin src="([^\"]+)"><\/script>/);
const stylesheet = html.match(/<link rel="stylesheet" crossorigin href="([^\"]+)">/);
if (!script || !stylesheet) throw new Error('Expected one Vite script and stylesheet in the build.');

const assetPath = reference => resolve(output, reference.replace(/^\.\//, ''));
const js = await readFile(assetPath(script[1]), 'utf8');
const css = await readFile(assetPath(stylesheet[1]), 'utf8');
if (/<\/script/i.test(js) || /<\/style/i.test(css)) {
  throw new Error('Generated code contains an unsafe HTML closing tag.');
}
html = html.replace(script[0], () => `<script type="module">${js}</script>`);
html = html.replace(stylesheet[0], () => `<style>${css}</style>`);
html = html.replace('</body>', `<script id="nfcorpus-data" type="application/octet-stream">${dataset.toString('base64')}</script>\n</body>`);

const files = await readdir(resolve(output, 'assets'));
const expected = [script[1], stylesheet[1]].map(reference => reference.split('/').at(-1));
const leftover = files.filter(file => !expected.includes(file));
if (leftover.length) throw new Error(`Unbundled assets remain: ${leftover.join(', ')}`);
if (/<(?:script|link)\b[^>]+(?:src|href)="(?:\.?\/)?assets\//i.test(html)) {
  throw new Error('The HTML still references a build asset.');
}

await writeFile(resolve(output, 'ragbox.html'), html);
await rm(htmlPath);
await rm(resolve(output, 'assets'), { recursive: true });
console.log(`Built dist-single/ragbox.html (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB)`);
