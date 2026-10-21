export { errorMessage, errorName } from './errors.ts';

export function rowsAs<T>(table: { toArray(): unknown[] }): T[] {
  return table.toArray() as T[];
}
