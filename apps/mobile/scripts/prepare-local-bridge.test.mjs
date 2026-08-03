import { describe, expect, it, vi } from "vitest";
import { LOCAL_BRIDGE_PORTS, parseConnectedDevices, prepareLocalBridge } from "./prepare-local-bridge.mjs";

describe("prepare-local-bridge", () => {
  it("only returns connected Android devices", () => {
    expect(parseConnectedDevices("List of devices attached\nemulator-5554\tdevice\noffline-1\toffline\nunauthorized-1\tunauthorized\n")).toEqual(["emulator-5554"]);
  });

  it("reverses the broker, API, Metro, and Sync ports for every device", () => {
    const run = vi.fn((command, args) => (args[0] === "devices" ? "List of devices attached\nphone-1\tdevice\n" : ""));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = prepareLocalBridge({ run, log });

    expect(result).toEqual({ status: "ready", devices: ["phone-1"], ports: LOCAL_BRIDGE_PORTS });
    expect(run).toHaveBeenCalledTimes(1 + LOCAL_BRIDGE_PORTS.length);
    expect(run).toHaveBeenNthCalledWith(2, "adb", ["-s", "phone-1", "reverse", "tcp:8787", "tcp:8787"]);
    expect(run).toHaveBeenNthCalledWith(5, "adb", ["-s", "phone-1", "reverse", "tcp:4100", "tcp:4100"]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and succeeds when no device is connected", () => {
    const run = vi.fn(() => "List of devices attached\n");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = prepareLocalBridge({ run, log });

    expect(result).toEqual({ status: "unavailable", devices: [], ports: [] });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("no Android device is connected"));
  });
});
