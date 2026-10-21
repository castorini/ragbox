import { expect, it, vi } from 'vitest';
import { acquireDatabaseLock, DatabaseInUseError } from '../src/database-lock.ts';

function lockManager(lock: Lock | null) {
  const request = vi.fn((_name: string, _options: LockOptions, callback: LockGrantedCallback<void>) =>
    Promise.resolve().then(() => callback(lock)));
  return { request, locks: { request } as unknown as LockManager };
}

it('holds an exclusive origin lock until the database owner releases it', async () => {
  const { request, locks } = lockManager({ name: 'ragbox:opfs:analytics.duckdb', mode: 'exclusive' } as Lock);
  const release = await acquireDatabaseLock(locks);
  expect(request).toHaveBeenCalledWith('ragbox:opfs:analytics.duckdb', {
    mode: 'exclusive', ifAvailable: true,
  }, expect.any(Function));
  const settled = vi.fn();
  const held = request.mock.results[0].value.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  release();
  await held;
  expect(settled).toHaveBeenCalledOnce();
  release();
});

it('immediately explains a confirmed duplicate tab instead of waiting for its lock', async () => {
  const { locks } = lockManager(null);
  const result = acquireDatabaseLock(locks);
  await expect(result).rejects.toBeInstanceOf(DatabaseInUseError);
  await expect(result).rejects.toThrow('already open in another tab or window');
  await expect(result).rejects.toThrow('close it and reload this page');
});

it('allows OPFS startup to provide the fallback when Web Locks are unavailable', async () => {
  const release = await acquireDatabaseLock(undefined);
  expect(() => release()).not.toThrow();
});

it('preserves Web Lock API failures without incorrectly reporting another tab', async () => {
  const error = new Error('Lock service unavailable');
  const locks = { request: vi.fn().mockRejectedValue(error) } as unknown as LockManager;
  await expect(acquireDatabaseLock(locks)).rejects.toBe(error);
});
