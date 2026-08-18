export function parseJson(value, context) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${context}: ${errorMessage(error)}`);
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
