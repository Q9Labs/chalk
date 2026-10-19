export async function assertHarnessPortAvailable(origin: string, name: string): Promise<void> {
  const occupied = await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
  if (occupied) throw new Error(`${name} harness port is occupied: ${origin}`);
}
