import { it, expect } from 'vitest';
import { downloadPrebuilt } from '../src/download-prebuilt.ts';
function fixture() {
  const state = { committed: false, aborted: false, received: 0 };
  return { state, root: { async getFileHandle() { return { async createWritable() {
    return { async write(chunk: Uint8Array) { state.received += chunk.length; },
      async close() { state.committed = true; }, async abort() { state.aborted = true; } };
  } }; } } };
}
const url = 'https://example.com/index.duckdb';
it('streams a complete response, reports progress, and commits', async () => {
  const { state, root } = fixture();
  const updates: number[] = [];
  await downloadPrebuilt({url, bytes: 3, root: root as unknown as FileSystemDirectoryHandle, name:'test', fetcher: async () => new Response('abc'), onProgress: n => updates.push(n)});
  expect(state).toEqual({committed:true, aborted:false, received:3});
  expect(updates.at(-1)).toBe(3);
});
it('aborts a truncated download without committing', async () => {
  const {state,root} = fixture();
  await expect(downloadPrebuilt({url,bytes:4,root: root as unknown as FileSystemDirectoryHandle,name:'test',fetcher:async()=>new Response('abc')})).rejects.toThrow('Incomplete');
  expect(state.aborted).toBe(true);
  expect(state.committed).toBe(false);
});
it('aborts on cancellation', async () => {
  const {state,root} = fixture();
  const controller = new AbortController();
  await expect(downloadPrebuilt({url,bytes:3,root: root as unknown as FileSystemDirectoryHandle,name:'test',signal:controller.signal,
    fetcher:async()=>new Response('abc'),onProgress:()=>controller.abort()})).rejects.toThrow();
  expect(state.aborted).toBe(true);
  expect(state.committed).toBe(false);
});
it('rejects HTTP errors and HTML responses before opening storage', async () => {
  const root = {getFileHandle() { throw new Error('must not open storage'); }};
  await expect(downloadPrebuilt({url,bytes:3,root: root as unknown as FileSystemDirectoryHandle,name:'test',fetcher:async()=>new Response('no',{status:404})})).rejects.toThrow('HTTP 404');
  await expect(downloadPrebuilt({url,bytes:3,root: root as unknown as FileSystemDirectoryHandle,name:'test',fetcher:async()=>new Response('abc',{headers:{'content-type':'text/html'}})})).rejects.toThrow('web page');
});
