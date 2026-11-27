import { simulcastUnsupported } from "./failure-policy";
import type { LocalTrackState } from "./local-publications";
import { firefoxCameraSimulcastUnsupported } from "./peer-connection";

export function addLocalTransceiver(connection: RTCPeerConnection, state: LocalTrackState, cameraSimulcast: boolean): RTCRtpTransceiver {
  if (state.source !== "camera" || !cameraSimulcast || firefoxCameraSimulcastUnsupported()) return connection.addTransceiver(state.track, { direction: "sendonly" });
  // 720p and 360p have a 4:1 pixel ratio; budget about 4:1 bandwidth.
  // Match a single-stream camera's temporal mode so h does not spend
  // its constrained uplink budget on extra temporal-layer overhead.
  const sendEncodings = [
    { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 2500000, scalabilityMode: "L1T1" },
    { rid: "l", scaleResolutionDownBy: 2, maxBitrate: 650000, scalabilityMode: "L1T1" },
  ];
  try {
    return connection.addTransceiver(state.track, {
      direction: "sendonly",
      sendEncodings,
    });
  } catch (error) {
    if (!simulcastUnsupported(error)) throw error;
    return connection.addTransceiver(state.track, { direction: "sendonly" });
  }
}
