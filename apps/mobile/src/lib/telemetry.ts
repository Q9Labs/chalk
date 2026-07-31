import AsyncStorage from "@react-native-async-storage/async-storage";
import { createKeyValueTelemetryStorage, createTelemetryClient, type TelemetryClient } from "@q9labsai/chalk-client/telemetry";

export interface MobileTelemetryOptions {
  readonly enabled: boolean;
}

export function createMobileTelemetry({ enabled }: MobileTelemetryOptions): TelemetryClient {
  return createTelemetryClient({
    enabled,
    maxQueueSize: 100,
    storage: createKeyValueTelemetryStorage(AsyncStorage, "chalk.mobile.telemetry.v1"),
  });
}

export async function flushAndDisposeTelemetry(telemetry: Pick<TelemetryClient, "dispose" | "flush">): Promise<void> {
  try {
    await telemetry.flush();
  } finally {
    telemetry.dispose();
  }
}
