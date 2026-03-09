export async function poll<T>(opts: { timeoutMs: number; intervalMs: number; action: () => Promise<T | null> | T | null }): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await opts.action();
    if (value != null) return value;

    if (Date.now() - start > opts.timeoutMs) {
      throw new Error(`Timed out after ${opts.timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}
