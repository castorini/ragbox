export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
