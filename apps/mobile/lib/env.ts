/**
 * Environment configuration for the mobile test app
 */

export const env = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'https://chalk-api.q9labs.ai',
  wsUrl: process.env.EXPO_PUBLIC_WS_URL ?? 'wss://chalk-api.q9labs.ai',
  apiKey: process.env.EXPO_PUBLIC_API_KEY ?? '',
  debug: process.env.EXPO_PUBLIC_DEBUG === 'true',
};
