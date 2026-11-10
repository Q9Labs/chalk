import { CALL_STATS_HISTORY } from "@q9labsai/chalk-client";
import type { CallCharts as Charts, NetworkSeries } from "./call-network";

const WIDTH = 328;
const HEIGHT = 36;
const LOSS_SCALE_PCT = 2;
const LATENCY_FLOOR_MS = 30;
const LATENCY_CEILING_MS = 60;
const BANDWIDTH_CEILING_MBPS = 4;

/** The newest window sits at the right edge; a call younger than the history leaves the left side empty. */
const slotX = (index: number, count: number): number => ((CALL_STATS_HISTORY - count + index) / (CALL_STATS_HISTORY - 1)) * WIDTH;

function peak(...series: NetworkSeries[]): number {
  return Math.max(0, ...series.flatMap((points) => points.filter((value): value is number => value !== null)));
}

function line(points: NetworkSeries, min: number, max: number): string {
  let path = "";
  let drawing = false;
  points.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    const y = HEIGHT - 2 - ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * (HEIGHT - 4);
    path += `${drawing ? "L" : "M"}${slotX(index, points.length).toFixed(1)} ${y.toFixed(1)}`;
    drawing = true;
  });
  return path;
}

function Row({ label, headline, unit, children }: { readonly label: React.ReactNode; readonly headline: string; readonly unit: string; readonly children: React.ReactNode }) {
  return (
    <div className="chalk-shell-chart">
      <div className="chalk-shell-chart-top">
        <span>{label}</span>
        <b>
          {headline}
          <small>{unit}</small>
        </b>
      </div>
      {children}
    </div>
  );
}

const Plot = ({ children }: { readonly children: React.ReactNode }) => (
  <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
    {children}
  </svg>
);

function Stroke({ d, color, opacity }: { readonly d: string; readonly color: string; readonly opacity?: number }) {
  return <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity={opacity} vectorEffect="non-scaling-stroke" />;
}

export function CallChartsView({ charts }: { readonly charts: Charts }) {
  const { latency, loss, bandwidth } = charts;
  const latencyMin = Math.min(LATENCY_FLOOR_MS, ...latency.points.filter((value): value is number => value !== null));
  const latencyMax = Math.max(LATENCY_CEILING_MS, peak(latency.points));
  const latencyLine = line(latency.points, latencyMin, latencyMax);
  const lossMax = Math.max(LOSS_SCALE_PCT, peak(loss.points));
  const barWidth = WIDTH / CALL_STATS_HISTORY;
  const bandwidthMax = Math.max(BANDWIDTH_CEILING_MBPS, peak(bandwidth.upload, bandwidth.download));
  return (
    <div className="chalk-shell-charts" role="group" aria-label="Connection over the last minute">
      <Row label="Latency" headline={latency.headline} unit="ms">
        <Plot>
          {latencyLine ? <path d={`${latencyLine}L${WIDTH} ${HEIGHT}L${slotX(0, latency.points.length)} ${HEIGHT}Z`} fill="var(--chalk-positive)" fillOpacity=".1" /> : null}
          <Stroke d={latencyLine} color="var(--chalk-positive)" />
        </Plot>
      </Row>
      <Row label="Packet loss" headline={loss.headline} unit="%">
        <Plot>
          {loss.points.map((value, index) => {
            if (value === null) return null;
            const height = Math.max(2, (value / lossMax) * (HEIGHT - 2));
            const fill = value >= 1 ? "var(--chalk-warning)" : value > 0 ? "var(--chalk-muted-text)" : "var(--chalk-line-strong)";
            return <rect key={index} x={(CALL_STATS_HISTORY - loss.points.length + index) * barWidth + 1} y={HEIGHT - height} width={barWidth - 2} height={height} rx="1" fill={fill} />;
          })}
        </Plot>
      </Row>
      <Row
        label={
          <span className="chalk-shell-chart-legend">
            <span>
              <i style={{ background: "var(--chalk-text)" }} />
              Upload
            </span>
            <span>
              <i style={{ background: "var(--chalk-accent)" }} />
              Download
            </span>
          </span>
        }
        headline={bandwidth.headline}
        unit="Mb/s"
      >
        <Plot>
          <Stroke d={line(bandwidth.download, 0, bandwidthMax)} color="var(--chalk-accent)" />
          <Stroke d={line(bandwidth.upload, 0, bandwidthMax)} color="var(--chalk-text)" opacity={0.7} />
        </Plot>
      </Row>
      <div className="chalk-shell-chart-axis" aria-hidden="true">
        <span>1 min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
