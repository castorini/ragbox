export class DatabaseInUseError extends Error {
  constructor(confirmed = true, options?: ErrorOptions) {
    super(confirmed
      ? 'RAGbox is already open in another tab or window in this browser. Only one tab can use its local database at a time. Continue in the other tab, or close it and reload this page.'
      : 'RAGbox could not open its local database because it is already in use. Another RAGbox tab or window may be using it. Close other RAGbox tabs and reload this page.', options);
    this.name = 'DatabaseInUseError';
  }
}

// Web Locks are scoped to the origin, just like the shared OPFS database.
// Hold the lock until DuckDB has stopped; the browser also releases it when
// the document is destroyed. No heartbeat or persistent tab flag is needed.
export function acquireDatabaseLock(locks: LockManager | undefined): Promise<() => void> {
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    void locks.request('ragbox:opfs:analytics.duckdb', { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) throw new DatabaseInUseError();
      return new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
