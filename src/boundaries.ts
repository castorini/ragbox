export function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

export { errorMessage, errorName } from './errors.ts';

export function rowsAs<T>(table: { toArray(): unknown[] }): T[] {
  return table.toArray() as T[];
}
