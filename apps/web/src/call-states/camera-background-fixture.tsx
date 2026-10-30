import "../styles.css";
import "../lib/camera-effects";
import { createRoot } from "react-dom/client";
import { processCameraStream, setCameraBackground, getCameraBackground, getCameraBackgroundFallback, type CameraBackground } from "@q9labsai/chalk-client";
import { PreviewDevicePopover } from "@q9labsai/chalk-react/preview";
import { syntheticCamera } from "./camera-fixtures/synthetic-camera";
import portraitUrl from "./camera-fixtures/webcam-subject.jpg";

/** Browser proof: the production capture hand-off and picker over real WebRTC peers. */
class CameraBackgroundFixture extends HTMLElement {
  async mount({ requireRemote = true, inputWidth = 1280, nativeCamera = false }: { readonly requireRemote?: boolean; readonly inputWidth?: number; readonly nativeCamera?: boolean } = {}) {
    const portrait = new Image();
    portrait.src = portraitUrl;
    await portrait.decode();
    const nativeStream = nativeCamera ? await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } }) : undefined;
    const nativeTrack = nativeStream?.getVideoTracks()[0];
    if (nativeTrack) {
      const settings = nativeTrack.getSettings();
      nativeTrack.getSettings = () => ({ ...settings, deviceId: "proof-camera" });
    }
    const camera = nativeTrack ? { track: nativeTrack, stop: () => nativeTrack.stop() } : syntheticCamera(portrait, inputWidth);
    const source = camera.track;
    const raw = new MediaStream([source]);
    const processed = await processCameraStream(raw);
    const track = processed.getVideoTracks()[0];
    if (!track) throw new Error("Camera capture failed");
    const local = document.createElement("video");
    local.autoplay = true;
    local.muted = true;
    local.playsInline = true;
    local.srcObject = processed;
    local.setAttribute("aria-label", "Local video");
    const remote = document.createElement("video");
    remote.autoplay = true;
    remote.muted = true;
    remote.playsInline = true;
    remote.setAttribute("aria-label", "Remote video");
    const sending = new RTCPeerConnection();
    const receiving = new RTCPeerConnection();
    const publication = sending.addTransceiver(track, { direction: "sendonly" });
    receiving.ontrack = (event) => {
      remote.srcObject = new MediaStream([event.track]);
    };
    const gather = async (connection: RTCPeerConnection) => {
      if (connection.iceGatheringState === "complete") return;
      await new Promise<void>((resolve) =>
        connection.addEventListener("icegatheringstatechange", () => {
          if (connection.iceGatheringState === "complete") resolve();
        }),
      );
    };
    if (requireRemote) {
      await sending.setLocalDescription(await sending.createOffer());
      await gather(sending);
      if (!sending.localDescription) throw new Error("Missing offer");
      await receiving.setRemoteDescription(sending.localDescription);
      await receiving.setLocalDescription(await receiving.createAnswer());
      await gather(receiving);
      if (!receiving.localDescription) throw new Error("Missing answer");
      await sending.setRemoteDescription(receiving.localDescription);
    }
    const root = document.getElementById("root");
    if (!root) throw new Error("Missing root");
    root.replaceChildren(this);
    this.dataset.chalk = "";
    this.dataset.chalkTheme = "dark";
    this.className = "chalk-root";
    this.style.cssText = "display:block;min-height:100vh;padding:24px;background:var(--chalk-canvas);color:var(--chalk-text);";
    const heading = document.createElement("h1");
    heading.textContent = "Camera backgrounds";
    heading.style.cssText = "font-size:20px;margin:0 0 20px";
    this.appendChild(heading);
    const views = document.createElement("div");
    views.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px";
    for (const [label, video] of (
      [
        ["Local", local],
        ["Remote", remote],
      ] as const
    ).filter(([label]) => requireRemote || label === "Local")) {
      const view = document.createElement("div");
      const title = document.createElement("h2");
      title.textContent = label;
      title.style.cssText = "font-size:14px;margin:0 0 8px";
      video.style.cssText = "width:100%;aspect-ratio:16/9;object-fit:contain;border-radius:12px;background:#111";
      view.appendChild(title);
      view.appendChild(video);
      views.appendChild(view);
    }
    this.appendChild(views);
    const controls = document.createElement("div");
    controls.style.cssText = "padding-top:24px;text-align:center";
    this.appendChild(controls);
    const react = createRoot(controls);
    react.render(<PreviewDevicePopover type="video" isActive onToggle={() => {}} devices={[{ deviceId: "proof-camera", label: "Camera", kind: "videoinput" }]} selectedDeviceId="proof-camera" onDeviceChange={() => {}} track={track} orientation="down" />);
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
    const id = publication.mid;
    return {
      async background(value: CameraBackground) {
        await setCameraBackground("proof-camera", value);
      },
      publication() {
        return { id: publication.mid, sameSender: sending.getSenders()[0] === publication.sender, sameTrack: publication.sender.track === track, state: sending.connectionState, trackState: track.readyState };
      },
      id,
      source() {
        const { width, height, frameRate } = source.getSettings();
        return { live: source.readyState === "live", sameTrack: track === source, width, height, frameRate };
      },
      backgroundState() {
        return { selected: getCameraBackground("proof-camera"), fallbackFps: getCameraBackgroundFallback("proof-camera") };
      },
      lifecycle() {
        track.enabled = false;
        const disabledCamera = !source.enabled;
        const preview = track.clone();
        preview.enabled = true;
        const privatePreview = source.enabled && !track.enabled;
        preview.stop();
        const stoppedPreview = !source.enabled;
        track.enabled = true;
        return { disabledCamera, privatePreview, stoppedPreview, resumedCamera: source.enabled };
      },
      frames() {
        return { local: local.getVideoPlaybackQuality().totalVideoFrames, remote: remote.getVideoPlaybackQuality().totalVideoFrames };
      },
      async stats() {
        const stats = await receiving.getStats();
        const inbound = [...stats.values()].find((entry) => entry.type === "inbound-rtp" && entry.kind === "video");
        return { framesDecoded: inbound?.framesDecoded ?? 0, framesPerSecond: inbound?.framesPerSecond ?? 0 };
      },
      pixels(localOnly = false) {
        const pixels = document.createElement("canvas");
        pixels.width = 128;
        pixels.height = 72;
        const context = pixels.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Missing pixels context");
        context.drawImage(localOnly ? local : remote, 0, 0, 128, 72);
        return [...context.getImageData(0, 0, 128, 72).data];
      },
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
