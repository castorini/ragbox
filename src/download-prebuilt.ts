// Write to a staged OPFS stream. close() commits; abort() preserves an old file.
export interface DownloadOptions {
  url: string;
  bytes: number;
  root: FileSystemDirectoryHandle;
  name: string;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  fetcher?: typeof fetch;
}

export async function downloadPrebuilt({ url, bytes, root, name, signal, onProgress = () => {}, fetcher = fetch }: DownloadOptions) {
  if (!url) throw new Error('The public index download has not been configured yet.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('The index download requires HTTPS.');
  }
  const response = await fetcher(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Index download failed (HTTP ${response.status}).`);
  if (response.headers.get('content-type')?.includes('text/html')) {
    await response.body.cancel();
    throw new Error('The download URL returned a web page instead of a database.');
  }
  const reader = response.body.getReader();
  let writable: FileSystemWritableFileStream | undefined;
  let received = 0;
  try {
    const handle = await root.getFileHandle(name, { create: true });
    writable = await handle.createWritable();
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > bytes) throw new Error('Downloaded index exceeds the configured file size.');
      await writable.write(value);
      onProgress(received, bytes);
    }
    signal?.throwIfAborted();
    if (received !== bytes) throw new Error(`Incomplete index: received ${received} of ${bytes} bytes.`);
    await writable.close();
    return received;
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
