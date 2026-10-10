export class BridgeError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function publicError(error: unknown): BridgeError {
  return error instanceof BridgeError ? error : new BridgeError('INTERNAL', 'Operation failed; inspect host status', 500);
}
export function deadline<T>(promise: Promise<T>, ms: number, code = 'TIMEOUT'): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError(code, 'Operation timed out', 504)), ms);
  })]).finally(() => clearTimeout(timer));
}
