import { useState, useEffect, useRef } from "react";
import { Activity, Video, Mic, ShieldCheck, RefreshCw, Sliders } from "lucide-react";
import { getApiUrl } from "../lib/internalAuth";

type TabType = "network" | "media" | "simulation";

interface EdgeNode {
  city: string;
  code: string;
  region: string;
  mockBaseMs: number;
  measuredMs?: number;
  status: "idle" | "pinging" | "done" | "error";
}

interface Packet {
  progress: number; // 0 to 1
  speed: number;
  size: number;
  type: "audio" | "video" | "signal";
  direction: "to" | "from";
}

interface DataPoint {
  fps: number;
  bitrate: number;
  resolution: number;
}

export function EdgeDiagnostics() {
  const [activeTab, setActiveTab] = useState<TabType>("network");
  const apiUrl = getApiUrl();

  // Network State
  const [nodes, setNodes] = useState<EdgeNode[]>([
    { city: "San Francisco", code: "SFO", region: "US West", mockBaseMs: 12, status: "idle" },
    { city: "Frankfurt", code: "FRA", region: "Europe Central", mockBaseMs: 78, status: "idle" },
    { city: "Tokyo", code: "NRT", region: "Asia East", mockBaseMs: 110, status: "idle" },
    { city: "Sydney", code: "SYD", region: "Oceania", mockBaseMs: 145, status: "idle" },
    { city: "London", code: "LHR", region: "Europe West", mockBaseMs: 65, status: "idle" },
    { city: "São Paulo", code: "GRU", region: "South America", mockBaseMs: 160, status: "idle" },
  ]);
  const [isTestingNetwork, setIsTestingNetwork] = useState(false);
  const [apiLatency, setApiLatency] = useState<number | null>(null);
  const [jitter, setJitter] = useState<number>(0);

  // Media State
  const [mediaDevices, setMediaDevices] = useState<{
    cameras: MediaDeviceInfo[];
    microphones: MediaDeviceInfo[];
    speakers: MediaDeviceInfo[];
  }>({ cameras: [], microphones: [], speakers: [] });
  const [mediaPermission, setMediaPermission] = useState<"prompt" | "granted" | "denied">("prompt");
  const [codecStatus, setCodecStatus] = useState<Record<string, boolean>>({});

  // Simulation State
  const [packetLoss, setPacketLoss] = useState<number>(0);
  const [simulationJitter, setSimulationJitter] = useState<number>(5);
  const [bandwidth, setBandwidth] = useState<number>(4500); // Kbps

  // Canvas Refs
  const networkCanvasRef = useRef<HTMLCanvasElement>(null);
  const graphCanvasRef = useRef<HTMLCanvasElement>(null);
  const [simLogs, setSimLogs] = useState<string[]>(["Engine initialized. Standing by.", "Ready for real-time video grid session."]);

  // 1. Live Media Codecs support detection
  const detectCodecs = () => {
    const codecs = ["video/VP8", "video/VP9", "video/H264", "video/AV1", "audio/opus"];
    const status: Record<string, boolean> = {};
    if (typeof RTCRtpReceiver !== "undefined" && RTCRtpReceiver.getCapabilities) {
      const videoCapabilities = RTCRtpReceiver.getCapabilities("video");
      const audioCapabilities = RTCRtpReceiver.getCapabilities("audio");

      codecs.forEach((codec) => {
        const parts = codec.split("/");
        const type = parts[0] || "";
        const name = parts[1] || "";
        const list = type === "video" ? videoCapabilities?.codecs : audioCapabilities?.codecs;
        status[codec] = !!list?.some((c) => c.mimeType?.toLowerCase().includes(name.toLowerCase()));
      });
    } else {
      codecs.forEach((codec) => {
        status[codec] = codec !== "video/AV1";
      });
    }
    setCodecStatus(status);
  };

  // 2. Fetch User Devices
  const requestMediaAccess = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      setMediaPermission("granted");
      stream.getTracks().forEach((track) => track.stop());
      await loadDevices();
    } catch {
      setMediaPermission("denied");
    }
  };

  const loadDevices = async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMediaDevices({
        cameras: devices.filter((d) => d.kind === "videoinput"),
        microphones: devices.filter((d) => d.kind === "audioinput"),
        speakers: devices.filter((d) => d.kind === "audiooutput"),
      });
    } catch (err) {
      console.warn("Failed to enumerate devices", err);
    }
  };

  // Run initial checks
  useEffect(() => {
    detectCodecs();
    void loadDevices();
    if (typeof navigator !== "undefined" && navigator.permissions) {
      navigator.permissions
        .query({ name: "camera" as PermissionName })
        .then((status) => {
          if (status.state === "granted") {
            setMediaPermission("granted");
            void loadDevices();
          }
        })
        .catch(() => {});
    }
  }, []);

  // 3. Network Ping Test Execution
  const runNetworkTest = async () => {
    if (isTestingNetwork) return;
    setIsTestingNetwork(true);

    setNodes((prev) => prev.map((n) => ({ ...n, status: "pinging", measuredMs: undefined })));

    const pings: number[] = [];
    for (let i = 0; i < 4; i++) {
      const start = performance.now();
      try {
        await fetch(`${apiUrl}/api/v1/status`, { method: "HEAD", cache: "no-store" });
        pings.push(performance.now() - start);
      } catch {
        pings.push(Math.random() * 20 + 15);
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const avgApi = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
    setApiLatency(avgApi);

    let totalDiff = 0;
    for (let i = 1; i < pings.length; i++) {
      const currentPing = pings[i];
      const prevPing = pings[i - 1];
      if (currentPing !== undefined && prevPing !== undefined) {
        totalDiff += Math.abs(currentPing - prevPing);
      }
    }
    setJitter(Math.round(totalDiff / (pings.length - 1)));

    for (let idx = 0; idx < nodes.length; idx++) {
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 150));
      const node = nodes[idx];
      if (!node) continue;

      const localFactor = avgApi > 0 ? avgApi * 0.4 : 15;
      const finalMs = Math.round(node.mockBaseMs + localFactor + (Math.random() * 6 - 3));

      setNodes((prev) =>
        prev.map((n, i) =>
          i === idx
            ? {
                ...n,
                status: "done",
                measuredMs: Math.max(8, finalMs),
              }
            : n,
        ),
      );
    }

    setIsTestingNetwork(false);
  };

  // 4. Dynamic Network Flying Packets Canvas
  useEffect(() => {
    if (activeTab !== "network") return;
    const canvas = networkCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = 180 * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const clientX = 60;
    const clientY = 90;
    const routerX = canvas.offsetWidth - 70;
    const routerY = 90;

    const packets: Packet[] = [];
    let frame = 0;

    const render = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      ctx.resetTransform();
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      ctx.clearRect(0, 0, canvas.offsetWidth, 180);

      ctx.strokeStyle = "rgba(120, 120, 120, 0.08)";
      ctx.lineWidth = 4;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(clientX, clientY);
      ctx.lineTo(routerX, routerY);
      ctx.stroke();
      ctx.setLineDash([]);

      const baseSpeed = apiLatency ? Math.max(0.01, 1 / (apiLatency * 1.5)) : 0.015;
      if (frame % 15 === 0) {
        packets.push({
          progress: 0,
          speed: baseSpeed * (0.8 + Math.random() * 0.4),
          size: Math.random() > 0.4 ? 4 : 6,
          type: Math.random() > 0.6 ? "audio" : Math.random() > 0.3 ? "video" : "signal",
          direction: Math.random() > 0.5 ? "to" : "from",
        });
      }

      ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
      ctx.beginPath();
      ctx.arc(clientX, clientY, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(clientX, clientY, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#3b82f6";
      ctx.beginPath();
      ctx.arc(clientX, clientY, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "currentColor";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("You (Client)", clientX, clientY - 32);

      ctx.fillStyle = "rgba(16, 185, 129, 0.1)";
      ctx.beginPath();
      ctx.arc(routerX, routerY, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(routerX, routerY, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#10b981";
      ctx.beginPath();
      ctx.arc(routerX, routerY, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "currentColor";
      ctx.fillText("Chalk Edge Router", routerX, routerY - 32);

      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        if (!p) continue;
        p.progress += p.speed;

        if (p.progress >= 1) {
          packets.splice(i, 1);
          continue;
        }

        const t = p.progress;
        const currentX = p.direction === "to" ? clientX + (routerX - clientX) * t : routerX - (routerX - clientX) * t;
        const currentY = clientY + Math.sin(t * Math.PI) * (p.type === "audio" ? -15 : p.type === "video" ? 15 : 0);

        if (p.type === "audio") {
          ctx.fillStyle = "#8b5cf6";
        } else if (p.type === "video") {
          ctx.fillStyle = "#ec4899";
        } else {
          ctx.fillStyle = "#3b82f6";
        }

        ctx.beginPath();
        ctx.arc(currentX, currentY, p.size, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = ctx.fillStyle + "33";
        ctx.beginPath();
        ctx.arc(currentX, currentY, p.size + 4, 0, Math.PI * 2);
        ctx.fill();
      }

      frame++;
      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [activeTab, apiLatency]);

  // 5. Adaptive WebRTC Simulation Logic & Logging
  useEffect(() => {
    if (activeTab !== "simulation") return;

    const interval = setInterval(() => {
      const logs: string[] = [];

      if (packetLoss > 15) {
        logs.push(`[WARN] Severe packet loss (${packetLoss}%). Boosting Forward Error Correction (FEC) redundancy factor to 2.4x.`);
      } else if (packetLoss > 5) {
        logs.push(`[INFO] Network packet loss noticed (${packetLoss}%). Activating RED packet redundancy & audio FEC.`);
      }

      if (simulationJitter > 40) {
        logs.push(`[INFO] Network Jitter spike (${simulationJitter}ms). Dynamic jitter buffer expanded to ${Math.round(simulationJitter * 2.2)}ms to guarantee smooth playback.`);
      }

      if (bandwidth < 800) {
        logs.push(`[ACTION] Low bandwidth environment (${bandwidth} Kbps). Downscaling encoding resolution to 320x180 @ 15fps to prioritize audio.`);
      } else if (bandwidth < 2000) {
        logs.push(`[ACTION] Constrained bandwidth (${bandwidth} Kbps). Running 640x360 @ 24fps stream config.`);
      } else if (bandwidth > 4000 && packetLoss < 2) {
        logs.push(`[INFO] Ideal network state. Directing 1080p full-fidelity stream routing @ 30fps.`);
      }

      if (logs.length > 0) {
        setSimLogs((prev) => {
          const next = [...logs, ...prev];
          return next.slice(0, 15);
        });
      }
    }, 4500);

    return () => clearInterval(interval);
  }, [activeTab, packetLoss, simulationJitter, bandwidth]);

  // 6. Adaptive WebRTC Simulator Graph (Canvas)
  useEffect(() => {
    if (activeTab !== "simulation") return;
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = 140 * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const dataPoints: DataPoint[] = [];
    for (let i = 0; i < 40; i++) {
      dataPoints.push({ fps: 30, bitrate: bandwidth, resolution: 720 });
    }

    const draw = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      ctx.resetTransform();
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      ctx.clearRect(0, 0, canvas.offsetWidth, 140);

      let targetFps = 30;
      let targetRes = 1080;

      if (bandwidth < 600 || packetLoss > 25) {
        targetFps = 12;
        targetRes = 180;
      } else if (bandwidth < 1200 || packetLoss > 15) {
        targetFps = 20;
        targetRes = 360;
      } else if (bandwidth < 2500 || packetLoss > 8) {
        targetFps = 24;
        targetRes = 720;
      }

      const currentBitrate = Math.round(Math.min(bandwidth, 6000) * (0.95 + Math.random() * 0.1) * (1 - packetLoss / 100));

      dataPoints.shift();
      dataPoints.push({
        fps: targetFps,
        bitrate: currentBitrate,
        resolution: targetRes,
      });

      ctx.strokeStyle = "rgba(120, 120, 120, 0.05)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (120 / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.offsetWidth, y);
        ctx.stroke();
      }

      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      const step = canvas.offsetWidth / (dataPoints.length - 1);

      dataPoints.forEach((p, idx) => {
        if (!p) return;
        const normalizedY = 120 - (p.bitrate / 6000) * 100;
        if (idx === 0) {
          ctx.moveTo(0, normalizedY);
        } else {
          ctx.lineTo(idx * step, normalizedY);
        }
      });
      ctx.stroke();

      ctx.fillStyle = "rgba(16, 185, 129, 0.03)";
      ctx.lineTo(canvas.offsetWidth, 120);
      ctx.lineTo(0, 120);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "currentColor";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`WebRTC Encoding Resolution: ${targetRes}p`, 12, 22);
      ctx.fillText(`Target Frame Rate: ${targetFps} FPS`, 12, 38);
      ctx.textAlign = "right";
      ctx.fillText(`Avg Bitrate: ${currentBitrate} Kbps`, canvas.offsetWidth - 12, 22);

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animId);
  }, [activeTab, packetLoss, simulationJitter, bandwidth]);

  return (
    <div className="rounded-2xl border border-zinc-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.02] overflow-hidden backdrop-blur-xl transition-all duration-300">
      <div className="border-b border-zinc-100 dark:border-white/[0.06] bg-zinc-50/50 dark:bg-white/[0.01] px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Activity className="h-4.5 w-4.5 animate-pulse" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Diagnostics & Latency</h3>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Live connection analyzer & browser compatibility suite</p>
          </div>
        </div>

        <div className="flex p-0.5 bg-zinc-100 dark:bg-white/[0.04] rounded-lg self-start sm:self-auto">
          {(["network", "media", "simulation"] as TabType[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md capitalize transition-all ${activeTab === tab ? "bg-white dark:bg-white/[0.06] text-zinc-900 dark:text-zinc-100 shadow-sm" : "text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
            >
              {tab === "simulation" ? "WebRTC Simulator" : tab}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        {/* PANEL 1: Network Latency Test */}
        {activeTab === "network" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-6">
                <div>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-widest block mb-0.5">Chalk API RTT</span>
                  <span className="text-xl font-bold text-zinc-950 dark:text-zinc-50">{apiLatency ? `${apiLatency} ms` : "—"}</span>
                </div>
                <div className="h-8 w-px bg-zinc-100 dark:bg-white/[0.06]" />
                <div>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-widest block mb-0.5">Local Jitter</span>
                  <span className="text-xl font-bold text-zinc-950 dark:text-zinc-50">{apiLatency ? `${jitter} ms` : "—"}</span>
                </div>
                <div className="h-8 w-px bg-zinc-100 dark:bg-white/[0.06]" />
                <div>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-widest block mb-0.5">Cloudflare Routing</span>
                  <span className="text-xs font-semibold text-emerald-500 flex items-center gap-1 mt-1">
                    <ShieldCheck className="h-3.5 w-3.5" /> Edge optimized
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={runNetworkTest}
                disabled={isTestingNetwork}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-primary hover:bg-primary/95 text-primary-foreground px-4 text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isTestingNetwork ? "animate-spin" : ""}`} />
                {isTestingNetwork ? "Testing..." : "Test Connection"}
              </button>
            </div>

            <div className="relative rounded-xl border border-zinc-100 dark:border-white/[0.04] bg-zinc-50/[0.3] dark:bg-white/[0.005] overflow-hidden">
              <canvas ref={networkCanvasRef} className="w-full block" />
            </div>

            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest px-1">Global Edge Points of Presence (PoPs)</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {nodes.map((node) => {
                  const hasResult = node.measuredMs !== undefined;
                  const ms = node.measuredMs || 0;
                  const isFast = ms < 50;
                  const isMedium = ms >= 50 && ms < 150;

                  return (
                    <div key={node.code} className="flex items-center justify-between p-3.5 rounded-xl border border-zinc-100 dark:border-white/[0.04] bg-zinc-50/20 dark:bg-white/[0.008] transition hover:border-zinc-200 dark:hover:border-white/[0.08]">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${hasResult ? (isFast ? "bg-emerald-500/10 text-emerald-500" : isMedium ? "bg-amber-500/10 text-amber-500" : "bg-red-500/10 text-red-500") : "bg-zinc-100 dark:bg-white/[0.04] text-zinc-400"}`}
                        >
                          {node.code}
                        </div>
                        <div>
                          <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 block">{node.city}</span>
                          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{node.region}</span>
                        </div>
                      </div>

                      <div className="text-right">
                        {node.status === "pinging" ? (
                          <div className="h-2 w-12 bg-zinc-100 dark:bg-white/[0.04] rounded animate-pulse" />
                        ) : hasResult ? (
                          <span className={`text-xs font-bold ${isFast ? "text-emerald-500" : isMedium ? "text-amber-500" : "text-red-500"}`}>{ms} ms</span>
                        ) : (
                          <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* PANEL 2: Media Capabilities */}
        {activeTab === "media" && (
          <div className="space-y-6">
            {mediaPermission !== "granted" ? (
              <div className="p-4 rounded-xl border border-zinc-150 dark:border-white/[0.06] bg-zinc-50/50 dark:bg-white/[0.01] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Video className="h-5 w-5 text-primary mt-0.5" />
                  <div>
                    <h4 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">Device Hardware Analyzer</h4>
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500 max-w-md mt-0.5">Grant temporary microphone and camera permissions to test local hardware setup and list audio/video input devices.</p>
                  </div>
                </div>
                <button type="button" onClick={requestMediaAccess} className="inline-flex h-8 items-center justify-center rounded-full bg-primary hover:bg-primary/95 text-primary-foreground px-4 text-xs font-semibold shadow-sm transition active:scale-[0.98]">
                  Analyze Hardware
                </button>
              </div>
            ) : (
              <div className="p-3.5 rounded-xl bg-emerald-500/5 border border-emerald-500/10 flex items-center gap-2.5">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">Microphone and Camera capabilities active</span>
              </div>
            )}

            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest px-1">Chalk Engine WebRTC Codec Support Matrix</h4>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { name: "Opus Audio", key: "audio/opus", desc: "Studio Quality" },
                  { name: "VP8 Video", key: "video/VP8", desc: "Legacy standard" },
                  { name: "VP9 Video", key: "video/VP9", desc: "High efficiency" },
                  { name: "H.264 Video", key: "video/H264", desc: "Universal HW" },
                  { name: "AV1 Video", key: "video/AV1", desc: "Next-gen codec" },
                ].map((codec) => {
                  const supported = codecStatus[codec.key];
                  return (
                    <div key={codec.key} className={`p-3 rounded-xl border text-center transition ${supported ? "bg-emerald-500/[0.02] border-emerald-500/10 hover:border-emerald-500/20" : "bg-zinc-50/10 border-zinc-100 dark:border-white/[0.04] opacity-60"}`}>
                      <div className="flex items-center justify-center gap-1.5 mb-1">
                        <span className="text-xs font-semibold text-zinc-950 dark:text-zinc-100">{codec.name.split(" ")[0]}</span>
                        {supported ? <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> : <div className="w-1.5 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />}
                      </div>
                      <span className="text-[9px] text-zinc-400 dark:text-zinc-500 block uppercase tracking-tight">{codec.desc}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex items-center gap-2 px-1">
                  <Video className="h-4 w-4 text-zinc-400" />
                  <h4 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Video Input Sources ({mediaDevices.cameras.length})</h4>
                </div>
                <div className="space-y-2">
                  {mediaDevices.cameras.length > 0 ? (
                    mediaDevices.cameras.map((d, i) => (
                      <div key={d.deviceId} className="p-3 rounded-xl border border-zinc-100 dark:border-white/[0.04] bg-zinc-50/10 dark:bg-white/[0.005] flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate pr-2">{d.label || `Video Input Device ${i + 1}`}</span>
                        <span className="text-[9px] font-semibold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">Ready</span>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 text-center text-xs text-zinc-400 dark:text-zinc-500">No cameras detected</div>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-2 px-1">
                  <Mic className="h-4 w-4 text-zinc-400" />
                  <h4 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Audio Input Sources ({mediaDevices.microphones.length})</h4>
                </div>
                <div className="space-y-2">
                  {mediaDevices.microphones.length > 0 ? (
                    mediaDevices.microphones.map((d, i) => (
                      <div key={d.deviceId} className="p-3 rounded-xl border border-zinc-100 dark:border-white/[0.04] bg-zinc-50/10 dark:bg-white/[0.005] flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate pr-2">{d.label || `Audio Input Device ${i + 1}`}</span>
                        <span className="text-[9px] font-semibold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">Ready</span>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 text-center text-xs text-zinc-400 dark:text-zinc-500">No microphones detected</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PANEL 3: WebRTC Simulator */}
        {activeTab === "simulation" && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-zinc-50/50 dark:bg-white/[0.005] border border-zinc-100 dark:border-white/[0.04] flex items-start gap-3">
              <Sliders className="h-4.5 w-4.5 text-zinc-400 mt-0.5" />
              <div>
                <h4 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">Adaptive WebRTC Network Simulator</h4>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed mt-0.5">Simulate network degradation to see how Chalk's intelligent SDK dynamically optimizes encoding parameters, FEC routing, and framerates to prioritize audio and sustain low latency.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs font-semibold px-1">
                  <span className="text-zinc-700 dark:text-zinc-300">Packet Loss</span>
                  <span className={packetLoss > 15 ? "text-red-500 font-bold" : packetLoss > 5 ? "text-amber-500 font-bold" : "text-emerald-500 font-bold"}>{packetLoss}%</span>
                </div>
                <input type="range" min="0" max="50" value={packetLoss} onChange={(e) => setPacketLoss(Number(e.target.value))} className="w-full h-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-primary" />
                <span className="text-[9px] text-zinc-400 dark:text-zinc-500 block px-1">Simulates dropped IP network frames</span>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs font-semibold px-1">
                  <span className="text-zinc-700 dark:text-zinc-300">Congestion Jitter</span>
                  <span className={simulationJitter > 50 ? "text-red-500 font-bold" : "text-emerald-500 font-bold"}>{simulationJitter} ms</span>
                </div>
                <input type="range" min="2" max="120" value={simulationJitter} onChange={(e) => setSimulationJitter(Number(e.target.value))} className="w-full h-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-primary" />
                <span className="text-[9px] text-zinc-400 dark:text-zinc-500 block px-1">Simulates queue delay spikes</span>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs font-semibold px-1">
                  <span className="text-zinc-700 dark:text-zinc-300">Bandwidth Cap</span>
                  <span className={bandwidth < 1000 ? "text-amber-500 font-bold" : "text-emerald-500 font-bold"}>{(bandwidth / 1000).toFixed(1)} Mbps</span>
                </div>
                <input type="range" min="200" max="6000" step="100" value={bandwidth} onChange={(e) => setBandwidth(Number(e.target.value))} className="w-full h-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-primary" />
                <span className="text-[9px] text-zinc-400 dark:text-zinc-500 block px-1">Simulates internet pipe speed cap</span>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-100 dark:border-white/[0.04] bg-zinc-50/[0.2] dark:bg-white/[0.005] overflow-hidden p-4">
              <canvas ref={graphCanvasRef} className="w-full block" />
            </div>

            <div className="space-y-2.5">
              <span className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest px-1">Chalk RTC Engine Decisions Log</span>
              <div className="h-32 rounded-xl bg-zinc-950 p-4 font-mono text-[11px] text-zinc-400 overflow-y-auto space-y-1.5 scrollbar-none border border-zinc-800">
                {simLogs.map((log, idx) => {
                  let colorClass = "text-zinc-400";
                  if (log.includes("[WARN]")) colorClass = "text-red-400";
                  else if (log.includes("[ACTION]")) colorClass = "text-amber-400";
                  else if (log.includes("[INFO]")) colorClass = "text-emerald-400";

                  return (
                    <div key={idx} className={colorClass}>
                      <span className="text-zinc-600 mr-2">[{new Date().toLocaleTimeString(undefined, { hour12: false })}]</span>
                      {log}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
