export interface RealtimeKitInitConfig {
  authToken: string;
  defaults: {
    audio: boolean;
    video: boolean;
  };
}

export interface RealtimeKitInstance {
  join: () => Promise<void>;
}

export interface RealtimeKitStatic {
  init: (config: RealtimeKitInitConfig) => Promise<RealtimeKitInstance>;
}

export type RealtimeKitLoader = () => Promise<RealtimeKitStatic>;

export const importWebRealtimeKit: RealtimeKitLoader = async () => {
  const module = await import("@cloudflare/realtimekit");
  return module.default;
};
