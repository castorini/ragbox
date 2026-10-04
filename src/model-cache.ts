export const MODEL_ID = 'Mike0021/MiniCPM5-2B-ONNX';
export const MODEL_REVISION = '04a6c49fcba3a65a0351c92644c3a7e9d4343059';
export const MODEL_REMOTE_PATH_TEMPLATE = `{model}/resolve/${MODEL_REVISION}/`;

export interface ModelCacheFile {
  cache: string;
  url: string;
  path: string;
  size: number | null;
}

export function modelCachePath(url: string): string | null {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    // Include old local-model entries, but match complete path components only.
    for (const prefix of [`/${MODEL_ID}/`, `/models/${MODEL_ID}/`]) {
      if (path.startsWith(prefix)) return path.slice(prefix.length);
    }
  } catch { /* Malformed URLs are not model files. */ }
  return null;
}

export async function listModelCacheFiles(storage: CacheStorage): Promise<ModelCacheFile[]> {
  const files: ModelCacheFile[] = [];
  for (const name of await storage.keys()) {
    const cache = await storage.open(name);
    for (const request of await cache.keys()) {
      const path = modelCachePath(request.url);
      if (path === null) continue;
      const response = await cache.match(request);
      if (!response) continue;
      // Do not read multi-GB weights into memory just to calculate their size.
      const length = response.headers.get('content-length');
      const size = length === null ? null : Number(length);
      files.push({ cache: name, url: request.url, path,
        size: size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path) || a.cache.localeCompare(b.cache));
}

export async function deleteModelCacheFiles(storage: CacheStorage): Promise<void> {
  for (const name of await storage.keys()) {
    const cache = await storage.open(name);
    for (const request of await cache.keys()) {
      if (modelCachePath(request.url) !== null && !await cache.delete(request)) {
        // An entry removed by another tab is already gone; otherwise report failure.
        if (await cache.match(request)) throw new Error(`Could not delete model cache entry: ${request.url}`);
      }
    }
  }
}
