export async function waitFor(label, check, attempts = 30) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${label} was not observable within ${attempts} seconds${detail}`);
}
