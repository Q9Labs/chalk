export const importReactNativeRealtimeKit = async () => {
  const module = await import("@cloudflare/realtimekit-react-native");
  return module.default as any;
};
