export class BusinessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'BusinessError';
  }
}
export function requireFact(condition: unknown, code: string, message: string, status = 409): asserts condition {
  if (!condition) throw new BusinessError(code, message, status);
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
