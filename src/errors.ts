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

export type MetadataSample<T> = { state: 'read'; meta: T } | { state: 'deferred' };
export async function sampleMetadata<T>(read: () => Promise<T>): Promise<MetadataSample<T>> {
  try { return { state: 'read', meta: await read() }; }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SESSION_TRANSITION')
      return { state: 'deferred' };
    throw error;
  }
}
