import { it, expect } from 'vitest';
import { copyPrebuilt, PREBUILT_NAME } from '../src/prebuilt-msmarco.ts';
it('streams the selected database to the dedicated OPFS file', async () => {
  const chunks: Uint8Array[] = [];
  const file = new Blob(['database bytes']);
  const root = { async getFileHandle(name: string, options?: { create?: boolean }) {
    expect(name).toBe(PREBUILT_NAME);
    expect(options).toEqual({ create: true });
    return { async createWritable() { return new WritableStream({ write(chunk) { chunks.push(chunk); } }); } };
  } };
  await copyPrebuilt(file, root as unknown as FileSystemDirectoryHandle);
  expect(await new Blob(chunks as unknown as BlobPart[]).text()).toBe('database bytes');
});
it('propagates a quota/write failure rather than reporting success', async () => {
  const root = { async getFileHandle() { return { async createWritable() {
    return new WritableStream({ write() { throw new Error('quota exceeded'); } });
  } }; } };
  await expect(copyPrebuilt(new Blob(['data']), root as unknown as FileSystemDirectoryHandle)).rejects.toThrow('quota exceeded');
});
