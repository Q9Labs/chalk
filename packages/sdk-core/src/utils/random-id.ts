const hasSecureRandomUuid = (): boolean => typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.getRandomValues === "function" && typeof globalThis.crypto.randomUUID === "function";

const fallbackUuid = (): string =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const randomNibble = (Math.random() * 16) | 0;
    const value = char === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  });

export const createRandomId = (): string => {
  if (hasSecureRandomUuid()) {
    return globalThis.crypto.randomUUID();
  }

  return fallbackUuid();
};
