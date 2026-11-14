import "../styles.css";
import "../lib/camera-effects";
import { createRoot } from "react-dom/client";
import { loadCameraBackgroundControls, processCameraStream, setCameraBackground, getCameraBackgroundFallback, type CameraBackground } from "@q9labsai/chalk-client";
import { PreviewDevicePopover } from "@q9labsai/chalk-react/preview";
import { syntheticCamera } from "./camera-fixtures/synthetic-camera";
import portraitUrl from "./camera-fixtures/webcam-subject.jpg";

type MountOptions = { readonly requireRemote?: boolean; readonly inputWidth?: number; readonly nativeCamera?: boolean };

async function openCamera(inputWidth: number, nativeCamera: boolean) {
  const portrait = new Image();
  portrait.src = portraitUrl;
  await portrait.decode();
  const nativeStream = nativeCamera ? await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } }) : undefined;
  const nativeTrack = nativeStream?.getVideoTracks()[0];
  if (!nativeTrack) return syntheticCamera(portrait, inputWidth);
  const settings = nativeTrack.getSettings();
  nativeTrack.getSettings = () => ({ ...settings, deviceId: "proof-camera" });
  return { track: nativeTrack, stop: () => nativeTrack.stop() };
}

function videoElement(label: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("aria-label", label);
  return video;
}

async function gather(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) =>
    connection.addEventListener("icegatheringstatechange", () => {
      if (connection.iceGatheringState === "complete") resolve();
    }),
  );
}

async function connectPeers(sending: RTCPeerConnection, receiving: RTCPeerConnection) {
  await sending.setLocalDescription(await sending.createOffer());
  await gather(sending);
  if (!sending.localDescription) throw new Error("Missing offer");
  await receiving.setRemoteDescription(sending.localDescription);
  await receiving.setLocalDescription(await receiving.createAnswer());
  await gather(receiving);
  if (!receiving.localDescription) throw new Error("Missing answer");
  await sending.setRemoteDescription(receiving.localDescription);
}

function titledView(label: string, video: HTMLVideoElement): HTMLElement {
  const view = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = label;
  title.style.cssText = "font-size:14px;margin:0 0 8px";
  video.style.cssText = "width:100%;aspect-ratio:16/9;object-fit:contain;border-radius:12px;background:#111";
  view.appendChild(title);
  view.appendChild(video);
  return view;
}

/** Lays out the page and returns the React root that renders the picker. */
function layOut(host: HTMLElement, views: readonly HTMLElement[], track: MediaStreamTrack) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing root");
  root.replaceChildren(host);
  host.dataset.chalk = "";
  host.dataset.chalkTheme = "dark";
  host.className = "chalk-root";
  host.style.cssText = "display:block;min-height:100vh;padding:24px;background:var(--chalk-canvas);color:var(--chalk-text);";
  const heading = document.createElement("h1");
  heading.textContent = "Camera backgrounds";
  heading.style.cssText = "font-size:20px;margin:0 0 20px";
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px";
  for (const view of views) grid.appendChild(view);
  const controls = document.createElement("div");
  controls.style.cssText = "padding-top:24px;text-align:center";
  for (const child of [heading, grid, controls]) host.appendChild(child);
  const react = createRoot(controls);
  react.render(<PreviewDevicePopover type="video" isActive onToggle={() => {}} devices={[{ deviceId: "proof-camera", label: "Camera", kind: "videoinput" }]} selectedDeviceId="proof-camera" onDeviceChange={() => {}} track={track} orientation="down" />);
  return react;
}

async function startPlayback(local: HTMLVideoElement, remote: HTMLVideoElement, requireRemote: boolean) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([local.play(), ...(requireRemote ? [remote.play()] : [])]),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Video did not start: ${JSON.stringify([local, remote].map((video) => ({ ready: video.readyState, paused: video.paused, frames: video.getVideoPlaybackQuality().totalVideoFrames })))}`)), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Mutes the camera, takes a private preview clone, and reports how the source followed each step. */
function lifecycleProof(track: MediaStreamTrack, source: MediaStreamTrack) {
  track.enabled = false;
  const disabledCamera = !source.enabled;
  const preview = track.clone();
  preview.enabled = true;
  const privatePreview = source.enabled && !track.enabled;
  preview.stop();
  const stoppedPreview = !source.enabled;
  track.enabled = true;
  return { disabledCamera, privatePreview, stoppedPreview, resumedCamera: source.enabled };
}

function pixelsOf(video: HTMLVideoElement): number[] {
  const pixels = document.createElement("canvas");
  pixels.width = 128;
  pixels.height = 72;
  const context = pixels.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Missing pixels context");
  context.drawImage(video, 0, 0, 128, 72);
  return [...context.getImageData(0, 0, 128, 72).data];
}

/** Browser proof: the production capture hand-off and picker over real WebRTC peers. */
class CameraBackgroundFixture extends HTMLElement {
  async mount({ requireRemote = true, inputWidth = 1280, nativeCamera = false }: MountOptions = {}) {
    const camera = await openCamera(inputWidth, nativeCamera);
    const source = camera.track;
    const processed = await processCameraStream(new MediaStream([source]));
    const { getCameraBackground } = await loadCameraBackgroundControls();
    const track = processed.getVideoTracks()[0];
    if (!track) throw new Error("Camera capture failed");
    const local = videoElement("Local video");
    local.srcObject = processed;
    const remote = videoElement("Remote video");
    const sending = new RTCPeerConnection();
    const receiving = new RTCPeerConnection();
    const publication = sending.addTransceiver(track, { direction: "sendonly" });
    receiving.ontrack = (event) => {
      remote.srcObject = new MediaStream([event.track]);
    };
    if (requireRemote) await connectPeers(sending, receiving);
    const views = [titledView("Local", local), ...(requireRemote ? [titledView("Remote", remote)] : [])];
    const react = layOut(this, views, track);
    await startPlayback(local, remote, requireRemote);
    return {
      async background(value: CameraBackground) {
        await setCameraBackground("proof-camera", value);
      },
      publication() {
        return { id: publication.mid, sameSender: sending.getSenders()[0] === publication.sender, sameTrack: publication.sender.track === track, state: sending.connectionState, trackState: track.readyState };
      },
      id: publication.mid,
      source() {
        const { width, height, frameRate } = source.getSettings();
        return { live: source.readyState === "live", sameTrack: track === source, width, height, frameRate };
      },
      backgroundState() {
        return { selected: getCameraBackground("proof-camera"), fallbackFps: getCameraBackgroundFallback("proof-camera") };
      },
      lifecycle: () => lifecycleProof(track, source),
      frames() {
        return { local: local.getVideoPlaybackQuality().totalVideoFrames, remote: remote.getVideoPlaybackQuality().totalVideoFrames };
      },
      async stats() {
        const stats = await receiving.getStats();
        const inbound = [...stats.values()].find((entry) => entry.type === "inbound-rtp" && entry.kind === "video");
        return { framesDecoded: inbound?.framesDecoded ?? 0, framesPerSecond: inbound?.framesPerSecond ?? 0 };
      },
      pixels: (localOnly = false) => pixelsOf(localOnly ? local : remote),
      dispose() {
        react.unmount();
        sending.close();
        receiving.close();
        track.stop();
        camera.stop();
        local.srcObject = null;
        remote.srcObject = null;
      },
    };
  }
}
customElements.define("chalk-camera-background-fixture", CameraBackgroundFixture);
declare global {
  interface Window {
    cameraBackgroundProof: Awaited<ReturnType<CameraBackgroundFixture["mount"]>>;
  }
  interface HTMLElementTagNameMap {
    "chalk-camera-background-fixture": CameraBackgroundFixture;
  }
}
