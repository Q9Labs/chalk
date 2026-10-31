import { describe, expect, it } from "vitest";
import { iceServersFor } from "./ice-servers";

describe("iceServersFor", () => {
  it("falls back to the bootstrap STUN server when the API sends no ICE servers", () => {
    expect(iceServersFor({ connectionId: "c", stunServer: "stun:stun.example:3478" })).toEqual([{ urls: "stun:stun.example:3478" }]);
    expect(iceServersFor({ connectionId: "c", stunServer: "stun:stun.example:3478", iceServers: [] })).toEqual([{ urls: "stun:stun.example:3478" }]);
  });

  it("hands STUN and TURN entries to the peer connection with their credentials", () => {
    const iceServers = [{ urls: ["stun:stun.example:3478"] }, { urls: ["turn:turn.example:3478?transport=udp", "turn:turn.example:3478?transport=tcp", "turns:turn.example:443?transport=tcp"], username: "user", credential: "secret" }];
    expect(iceServersFor({ connectionId: "c", stunServer: "stun:stun.example:3478", iceServers })).toEqual(iceServers);
  });
});
