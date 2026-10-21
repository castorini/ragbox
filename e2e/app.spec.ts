import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
async function localEngines(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('ragbox-tour-done', '1');
    Object.defineProperty(navigator, 'gpu', { value: undefined });
    const params = new URLSearchParams(location.search);
    if (params.has('legacy')) Object.defineProperty(navigator, 'locks', { value: undefined });
    if (params.has('failStartup')) navigator.storage.getDirectory = async () => { throw new DOMException('Synthetic storage permission failure', 'NotAllowedError'); };
  });
  // Test the actual engine and browser OPFS without depending on a public CDN.
  await context.route('https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/dist/**', async route => {
    const file = basename(new URL(route.request().url()).pathname);
    await route.fulfill({ body: await readFile(resolve('node_modules/@duckdb/duckdb-wasm/dist', file)), contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
}
async function ready(page: Page) { await expect(page.locator('main')).toHaveAttribute('data-startup', 'ready'); }
test.beforeEach(async ({ context }) => localEngines(context));
test('loads all views and guide assets under the Pages path with correct navigation and focus', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./'); await ready(page);
  await expect(page.getByRole('link', { name: 'History', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await expect(page).toHaveURL(/\?view=setup$/); await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();
  await page.goto('./?view=setup#collection-management'); await ready(page);
  await expect(page.locator('#collection-management')).toHaveAttribute('open', '');
  await page.getByRole('link', { name: 'How it works', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Get started with RAGbox.' })).toBeVisible();
  await expect(page.locator('.duckdb-guide-step').first().getByRole('link', { name: 'Model settings' })).toHaveAttribute('href', '?view=setup#model');
  for (const image of await page.locator('#duckdb-view img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    await expect(image).toHaveAttribute('src', /^\/ragbox\/images\//);
  }
  await page.getByLabel('Try a search').selectOption('river');
  await expect(page.locator('.duckdb-match-row').last().locator('mark')).toHaveText('river');
  await page.goBack(); await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test('duplicate tabs fail before starting a worker and recover when the owner closes', async ({ context, page }) => {
  await page.goto('./'); await ready(page);
  const duplicate = await context.newPage(); await duplicate.goto('./?view=duckdb');
  await expect(duplicate.locator('#status')).toContainText('already open in another tab or window');
  await expect(duplicate.locator('#status')).toContainText('close it and reload this page');
  expect(duplicate.workers()).toHaveLength(0);
  await ready(page); await page.close(); await duplicate.reload(); await ready(duplicate);
});
test('simultaneous startup elects exactly one database owner', async ({ context, page }) => {
  const second = await context.newPage();
  await Promise.all([page.goto('./'), second.goto('./?view=duckdb')]);
  await expect.poll(async () => (await Promise.all([page.locator('main').getAttribute('data-startup'), second.locator('main').getAttribute('data-startup')])).sort()).toEqual(['error', 'ready']);
});
test('recognizes native OPFS contention from an older tab and recovers', async ({ context, page }) => {
  await page.goto('./?legacy=1'); await ready(page);
  const duplicate = await context.newPage(); await duplicate.goto('./');
  await expect(duplicate.locator('#status')).toContainText('Another RAGbox tab or window may be using it');
  await expect(duplicate.locator('#status')).not.toContainText('createSyncAccessHandle');
  await page.close(); await duplicate.reload(); await ready(duplicate);
});
test('startup failure releases the lock without blaming another tab', async ({ context, page }) => {
  await page.goto('./?failStartup=1');
  await expect(page.locator('#status')).toContainText('Synthetic storage permission failure');
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.length ?? 0)).toBe(0);
  const healthy = await context.newPage(); await healthy.goto('./'); await ready(healthy);
});
test('keyboard navigation and the onboarding tour work without a model download', async ({ page }) => {
  await page.goto('./'); await ready(page);
  await page.getByRole('button', { name: 'Take a quick tour' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose a collection' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await page.getByRole('link', { name: 'Settings', exact: true }).first().focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();
});
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`captures light-theme layouts without horizontal overflow at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport); await page.goto('./'); await ready(page);
    await expect(page.getByRole('combobox', { name: 'Ask your documents' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('chat.png'), fullPage: true });
    await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('settings.png'), fullPage: true });
    await page.getByRole('link', { name: 'How it works', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('guide.png'), fullPage: true });
  });
}
test('restores existing IndexedDB chats and source snapshots without restarting interrupted inference', async ({ context, page }, info) => {
  await context.route('**/__seed__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fixture</title>' }));
  await page.goto('./__seed__');
  await page.evaluate(async () => {
    const request = indexedDB.open('ragbox-conversations', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('conversations', { keyPath: 'id' }); request.result.createObjectStore('meta'); };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction(['conversations', 'meta'], 'readwrite');
    tx.objectStore('conversations').put({ id: 'existing-chat', corpus: 'nfcorpus', title: 'Saved nutrition question', createdAt: 1, updatedAt: 2, turns: [{ id: 'existing-turn', question: 'Do nuts lower cholesterol?', answer: 'Saved partial answer [MED-1].', results: [{ id: 'MED-1', title: 'Existing source snapshot', text: 'The original stored abstract.', score: 3.2 }], includedIds: ['MED-1'], citedIds: ['MED-1'], phase: 'generating', stage: 'generate', message: 'Writing answer…', thinkingEffort: 'off', history: [] }] });
    tx.objectStore('meta').put(true, 'imported'); tx.objectStore('meta').put({ selected: 'nfcorpus', active: { nfcorpus: 'existing-chat' } }, 'navigation');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  });
  await page.goto('./'); await ready(page);
  await expect(page.getByText('Saved partial answer', { exact: false })).toBeVisible();
  await expect(page.getByText('Interrupted by a page reload. Retry to continue.')).toBeVisible();
  await page.getByRole('link', { name: '[MED-1]' }).click();
  await expect(page.getByText('The original stored abstract.').first()).toBeVisible();
  expect(page.workers()).toHaveLength(1);
  await page.getByRole('combobox', { name: 'Ask your documents' }).fill('A draft that survives navigation');
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Ask your documents' })).toHaveValue('A draft that survives navigation');
  await expect(page.getByText('The original stored abstract.').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('restored-chat-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('restored-chat-mobile.png'), fullPage: true });
});
test('returns composer focus after selecting a collection from the React selector or a card', async ({ page }) => {
  await page.goto('./'); await ready(page);
  await page.getByRole('combobox', { name: 'Document collection' }).click();
  await page.getByRole('option', { name: 'MS MARCO' }).click();
  await expect(page.getByRole('combobox', { name: 'Ask your documents' })).toBeFocused();
  await page.getByRole('button', { name: 'NFCorpus', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Ask your documents' })).toBeFocused();
});
test('wraps mobile collection actions when fonts have wider metrics', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('./'); await ready(page);
  await page.addStyleTag({ content: 'button { font-size: 15px !important; letter-spacing: .6px; }' });
  const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll<HTMLElement>('body *')].filter(element => element.getClientRects().length && element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, text: element.textContent?.slice(0, 80), width: element.getBoundingClientRect().width })).slice(-10) }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
});
