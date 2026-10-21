import { expect, it, vi } from 'vitest';
import { DuckDBAccessMode, DuckDBDataProtocol } from '@duckdb/duckdb-wasm';
import { openLocalDatabase } from '../src/open-local-database.ts';
import { DatabaseInUseError } from '../src/database-lock.ts';

it('registers both database and WAL before opening, including new empty files', async () => {
  const handles = [{ kind: 'file' }, { kind: 'file' }];
  const getFileHandle = vi.fn().mockResolvedValueOnce(handles[0]).mockResolvedValueOnce(handles[1]);
  const registerFileHandle = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn().mockImplementation(async () => {
    expect(registerFileHandle).toHaveBeenCalledTimes(2);
  });
  await openLocalDatabase({ registerFileHandle, open }, { getFileHandle } as unknown as FileSystemDirectoryHandle);
  for (const [i, name] of ['analytics.duckdb', 'analytics.duckdb.wal'].entries()) {
    expect(getFileHandle).toHaveBeenCalledWith(name, { create: true });
    expect(registerFileHandle).toHaveBeenNthCalledWith(i + 1, `opfs://${name}`, handles[i], DuckDBDataProtocol.BROWSER_FSACCESS, true);
  }
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ accessMode: DuckDBAccessMode.READ_WRITE }));
});

it('does not open the database when registering its writable handle fails', async () => {
  const open = vi.fn();
  const registerFileHandle = vi.fn().mockRejectedValue(new Error('File locked'));
  const root = { getFileHandle: vi.fn().mockResolvedValue({}) } as unknown as FileSystemDirectoryHandle;
  await expect(openLocalDatabase({ open, registerFileHandle }, root)).rejects.toThrow('File locked');
  expect(open).not.toHaveBeenCalled();
});

it.each([
  new Error("Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file..opfs://analytics.duckdb"),
  new DOMException('The file is locked.', 'NoModificationAllowedError'),
  new Error('NoModificationAllowedError: The file is locked.'),
])('explains OPFS contention from older tabs or browsers without Web Locks: %s', async error => {
  const open = vi.fn();
  const registerFileHandle = vi.fn().mockRejectedValue(error);
  const root = { getFileHandle: vi.fn().mockResolvedValue({}) } as unknown as FileSystemDirectoryHandle;
  const result = openLocalDatabase({ open, registerFileHandle }, root);
  await expect(result).rejects.toBeInstanceOf(DatabaseInUseError);
  await expect(result).rejects.toMatchObject({ cause: error });
  await expect(result).rejects.toThrow('Another RAGbox tab or window may be using it');
  await expect(result).rejects.toThrow('reload this page');
  expect(open).not.toHaveBeenCalled();
});

it('also explains a lock conflict when opening the registered database', async () => {
  const error = new DOMException('The file is locked.', 'NoModificationAllowedError');
  const open = vi.fn().mockRejectedValue(error);
  const registerFileHandle = vi.fn().mockResolvedValue(undefined);
  const root = { getFileHandle: vi.fn().mockResolvedValue({}) } as unknown as FileSystemDirectoryHandle;
  await expect(openLocalDatabase({ open, registerFileHandle }, root)).rejects.toBeInstanceOf(DatabaseInUseError);
});

it.each([
  new DOMException('Storage permission denied.', 'NotAllowedError'),
  new DOMException('Storage quota exceeded.', 'QuotaExceededError'),
  new Error("Failed to execute 'createSyncAccessHandle': permission denied"),
])('preserves unrelated storage errors: %s', async error => {
  const open = vi.fn();
  const registerFileHandle = vi.fn().mockRejectedValue(error);
  const root = { getFileHandle: vi.fn().mockResolvedValue({}) } as unknown as FileSystemDirectoryHandle;
  await expect(openLocalDatabase({ open, registerFileHandle }, root)).rejects.toBe(error);
});
