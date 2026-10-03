import { expect, it, vi } from 'vitest';
import { DuckDBAccessMode, DuckDBDataProtocol } from '@duckdb/duckdb-wasm';
import { openLocalDatabase } from '../src/open-local-database.ts';

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
