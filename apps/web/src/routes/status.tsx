import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Wrench, XCircle, Info } from "lucide-react";
import { Moon02Icon, Sun01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { ChalkLogo } from "../components/ChalkLogo";
import { useTheme } from "../context/theme";
import { getApiUrl } from "../lib/internalAuth";
import { getPublicAppUrl } from "../lib/publicUrl";

const STATUS_META_TITLE = "Chalk Status";
const STATUS_META_DESCRIPTION = "Live system status, incidents, uptime, and maintenance updates for Chalk.";
const STATUS_META_IMAGE_PATH = "/api/v1/status/card.png";

export const Route = createFileRoute("/status")({
  head: () => {
    const apiUrl = getApiUrl();
    const metaImageUrl = `${apiUrl}${STATUS_META_IMAGE_PATH}`;
    return {
      meta: [
        { title: STATUS_META_TITLE },
        { name: "description", content: STATUS_META_DESCRIPTION },
        { property: "og:title", content: STATUS_META_TITLE },
        { property: "og:description", content: STATUS_META_DESCRIPTION },
        { property: "og:type", content: "website" },
        { property: "og:url", content: getPublicAppUrl("/status") },
        { property: "og:image", content: metaImageUrl },
        { property: "og:image:alt", content: "Chalk status page preview" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: STATUS_META_TITLE },
        { name: "twitter:description", content: STATUS_META_DESCRIPTION },
        { name: "twitter:image", content: metaImageUrl },
      ],
    };
  },
  component: PublicStatusPage,
});

type HealthState = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

type StatusComponent = {
  id: string;
  name: string;
  description: string;
  state: HealthState;
  message: string;
  recentUptimePct: number | null;
  history: StatusHistoryBucket[];
};

type StatusHistoryBucket = {
  state: HealthState;
  timestamp: string | null;
  hasData: boolean;
};

type StatusIncident = {
  code: string;
  title: string;
  message: string;
  severity: string;
  status: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  resolvedAt: string | null;
  componentIds: string[];
};

type StatusMaintenance = {
  id: string;
  title: string;
  message: string;
  summary: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  componentIds: string[];
};

type StatusSummary = {
  generatedAt: string | null;
  overall: HealthState;
  components: StatusComponent[];
  activeIncidents: StatusIncident[];
  recentIncidents: StatusIncident[];
  maintenance: StatusMaintenance[];
  historyWindowLabel: string;
};

type IncidentEvent = {
  id: string;
  eventType: string;
  message: string;
  eventAt: string | null;
};

type IncidentDetails = {
  incident: StatusIncident;
  events: IncidentEvent[];
};

const POLL_INTERVAL_MS = 60_000;

function PublicStatusPage() {
  const apiUrl = getApiUrl();
  const { theme, toggleTheme } = useTheme();
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StatusSummary | null>(null);

  const [expandedIncidentCode, setExpandedIncidentCode] = useState<string | null>(null);
  const [incidentDetailsByCode, setIncidentDetailsByCode] = useState<Record<string, IncidentDetails>>({});
  const [incidentDetailsError, setIncidentDetailsError] = useState<Record<string, string>>({});
  const [incidentLoadingCode, setIncidentLoadingCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadSummary = async (backgroundRefresh: boolean) => {
      if (backgroundRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const res = await fetch(`${apiUrl}/api/v1/status`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`Status endpoint returned ${res.status}`);
        }

        const payload = normalizeStatusSummary(await res.json());
        if (cancelled) {
          return;
        }

        setSummary(payload);
        setError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load status");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    void loadSummary(false);
    const pollTimer = window.setInterval(() => {
      void loadSummary(true);
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, [apiUrl, reloadTick]);

  useEffect(() => {
    if (!expandedIncidentCode || incidentDetailsByCode[expandedIncidentCode]) {
      return;
    }

    let cancelled = false;
    setIncidentLoadingCode(expandedIncidentCode);
    setIncidentDetailsError((prev) => ({ ...prev, [expandedIncidentCode]: "" }));

    void (async () => {
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/status/incidents/${encodeURIComponent(expandedIncidentCode)}`,
          {
            headers: { Accept: "application/json" },
            cache: "no-store",
          },
        );
        if (!res.ok) {
          throw new Error(`Incident endpoint returned ${res.status}`);
        }

        const details = normalizeIncidentDetails(await res.json());
        if (cancelled) {
          return;
        }

        setIncidentDetailsByCode((prev) => ({ ...prev, [expandedIncidentCode]: details }));
      } catch (err) {
        if (cancelled) {
          return;
        }
        setIncidentDetailsError((prev) => ({
          ...prev,
          [expandedIncidentCode]: err instanceof Error ? err.message : "Failed to load incident timeline",
        }));
      } finally {
        if (!cancelled) {
          setIncidentLoadingCode((prev) => (prev === expandedIncidentCode ? null : prev));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiUrl, expandedIncidentCode, incidentDetailsByCode]);

  // Group resolved incidents by date
  const groupedIncidents = useMemo(() => {
    if (!summary) return [];
    const groups: Record<string, StatusIncident[]> = {};
    
    summary.recentIncidents.forEach(incident => {
      const timestamp = incident.resolvedAt || incident.lastSeenAt || incident.firstSeenAt;
      const dateKey = timestamp ? formatDateKey(timestamp) : "Unresolved";
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(incident);
    });

    return Object.entries(groups).sort(([a], [b]) => {
      if (a === "Unresolved") return -1;
      if (b === "Unresolved") return 1;
      return new Date(b).getTime() - new Date(a).getTime();
    });
  }, [summary]);

  const aggregateUptime = useMemo(() => {
    if (!summary) return null;
    const withUptime = summary.components.filter(c => c.recentUptimePct !== null);
    if (withUptime.length === 0) return null;
    const avg = withUptime.reduce((sum, c) => sum + (c.recentUptimePct ?? 0), 0) / withUptime.length;
    return avg.toFixed(avg % 1 === 0 ? 0 : 2);
  }, [summary]);

  const hasError = !loading && !summary && !!error;

  if (hasError) {
    return <StatusErrorState message={error || "Unable to reach status API"} onRetry={() => setReloadTick((tick) => tick + 1)} />;
  }

  const overallState = summary?.overall ?? "unknown";
  const overallMeta = stateMeta(overallState);
  const isHealthy = overallState === "operational";
  const isLoading = loading && !summary;
  const affectedComponents = summary?.components.filter(c => c.state !== "operational") ?? [];

  return (
    <div className="font-app min-h-screen bg-white dark:bg-[#030303] text-zinc-900 dark:text-zinc-100 antialiased tracking-tight">
      
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-6 h-16 flex items-center justify-between max-w-7xl">
          <div className="flex items-center gap-6">
            <Link to="/" className="hover:opacity-80 transition-opacity">
              <ChalkLogo />
            </Link>
            <nav className="flex items-center gap-6 text-sm font-medium tracking-tight">
              <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
                Home
              </Link>
              <span className="text-foreground font-bold">Status</span>
            </nav>
          </div>
          <div className="flex items-center gap-2 pl-2 md:pl-4 md:border-l border-border/50">
            <button type="button" onClick={toggleTheme} className="p-2 text-muted-foreground hover:text-foreground rounded-full hover:bg-secondary transition-colors" aria-label="Toggle theme">
              <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* Status Banner — slim when healthy, hero when degraded/outage/maintenance */}
      <div
        role="status"
        aria-live="polite"
        className={`w-full border-b ${isLoading ? "bg-zinc-50/80 dark:bg-zinc-950/30 border-zinc-200/60 dark:border-zinc-800/30" : isHealthy ? overallMeta.bannerBarClass : `bg-gradient-to-b ${overallMeta.heroGradientClass} to-transparent ${overallMeta.heroBorderClass}`}`}
      >
        <div
          className={`container mx-auto max-w-7xl px-6 transition-[padding,gap] duration-500 ease-in-out ${
            isLoading
              ? "py-3 flex items-center justify-center gap-3 text-center"
              : isHealthy
                ? "py-3 flex items-center justify-center gap-3 text-center"
                : "py-16 md:py-20 flex flex-col items-center justify-center gap-5 text-center"
          }`}
        >
          {isLoading ? (
            <>
              <div className="h-5 w-5 rounded-full bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-4 w-40 rounded bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
                <div className="h-3 w-64 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
              </div>
            </>
          ) : (
            <>
              <overallMeta.Icon
                className={`shrink-0 ${overallMeta.iconClass} transition-[width,height] duration-500 ${
                  isHealthy ? "h-5 w-5" : "h-10 w-10 opacity-80"
                }`}
              />
              <div className={`min-w-0 flex flex-col items-center transition-[gap] duration-500 ${isHealthy ? "" : "gap-2"}`}>
                <h1
                  className={`font-medium tracking-tight transition-[font-size,line-height] duration-500 ${
                    isHealthy
                      ? "text-sm leading-tight"
                      : "text-2xl md:text-3xl text-zinc-900 dark:text-zinc-50"
                  }`}
                >
                  {overallMeta.headline}
                </h1>
                <p
                  className={`opacity-80 leading-relaxed transition-[font-size,opacity] duration-500 ${
                    isHealthy
                      ? "mt-0.5 text-xs"
                      : "text-sm md:text-base max-w-xl text-zinc-600 dark:text-zinc-400"
                  }`}
                >
                  {overallMeta.subtext}
                </p>
              </div>

              {/* Affected component pills — only when unhealthy */}
              {!isHealthy && affectedComponents.length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-2 mt-3">
                  {affectedComponents.map((c) => {
                    const cMeta = stateMeta(c.state);
                    return (
                      <span
                        key={c.id}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/60 dark:bg-white/[0.04] border border-zinc-200/80 dark:border-white/[0.08] text-sm font-medium text-zinc-700 dark:text-zinc-300 backdrop-blur-sm"
                      >
                        <span className={`h-2 w-2 rounded-full ${cMeta.dotClass} animate-pulse`} />
                        {c.name}
                      </span>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <main
        className={`relative mx-auto flex w-full max-w-3xl flex-col px-6 pb-24 transition-[gap,padding] duration-500 ${
          isHealthy ? "gap-20 pt-12" : "gap-10 pt-8"
        }`}
      >

        {/* Active Incidents — prominent when unhealthy, naturally follows hero */}
        {isLoading ? (
          <section className="space-y-5">
            <div className="h-4 w-32 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse px-1" />
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-200/80 dark:border-white/[0.08] p-6">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="h-4 w-48 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                    <div className="h-5 w-16 rounded-full bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                  </div>
                  <div className="h-3 w-full rounded bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
                  <div className="h-3 w-2/3 rounded bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
                </div>
              </div>
            </div>
          </section>
        ) : null}
        {!isLoading && summary?.activeIncidents.length > 0 && (
          <section className="space-y-5">
            <h2 className="text-sm font-medium text-zinc-400 dark:text-zinc-500 px-1">Active Incidents</h2>
            <div className="space-y-4">
              {summary.activeIncidents.map((incident) => (
                <IncidentCard
                  key={incident.code}
                  incident={incident}
                  expanded={expandedIncidentCode === incident.code}
                  onToggle={() => setExpandedIncidentCode((current) => (current === incident.code ? null : incident.code))}
                  loading={incidentLoadingCode === incident.code}
                  details={incidentDetailsByCode[incident.code]}
                  error={incidentDetailsError[incident.code]}
                  isActive
                />
              ))}
            </div>
          </section>
        )}

        {/* Maintenance */}
        {!isLoading && summary?.maintenance.length > 0 && (
          <section className="space-y-5">
            <h2 className="text-sm font-medium text-zinc-400 dark:text-zinc-500 px-1">Scheduled Maintenance</h2>
            <div className="space-y-4">
              {summary.maintenance.map((window) => (
                <MaintenanceCard key={window.id} window={window} components={summary.components} />
              ))}
            </div>
          </section>
        )}

        {/* Receding group — system status & history fade when unhealthy, hero when healthy */}
        <div
          className={`flex flex-col ${
            isHealthy
              ? "gap-20"
              : "gap-8 opacity-70 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-300"
          }`}
        >
          {/* System Status Card */}
          <section className="space-y-5">
            <h2 className="text-sm font-medium text-zinc-400 dark:text-zinc-500 px-1">System Status</h2>
            {isLoading ? (
              <div className="rounded-2xl border border-zinc-200/80 dark:border-white/[0.08] bg-white dark:bg-white/[0.02] overflow-hidden">
                <div className="flex items-center justify-between border-b border-zinc-100 dark:border-white/[0.06] px-6 py-4">
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-4 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                    <div className="h-4 w-36 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                  </div>
                  <div className="h-3 w-24 rounded bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center justify-between px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-5 w-5 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                        <div className="space-y-1.5">
                          <div className="h-3.5 w-28 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                          <div className="h-2.5 w-44 rounded bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
                        </div>
                      </div>
                      <div className="h-5 w-16 rounded-md bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-zinc-200/80 dark:border-white/[0.08] bg-white dark:bg-white/[0.02] overflow-hidden">
                <div className="flex items-center justify-between border-b border-zinc-100 dark:border-white/[0.06] px-6 py-4 bg-zinc-50/50 dark:bg-white/[0.02]">
                  <div className="flex items-center gap-2">
                    <overallMeta.Icon className={`h-4 w-4 ${overallMeta.iconClass}`} />
                    <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{statusCardHeadline(summary?.overall ?? "unknown")}</span>
                    {aggregateUptime !== null && (
                      <span className="ml-1 rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-500">{aggregateUptime}% uptime</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
                    <Clock3 className="h-3 w-3" />
                    <span>{summary?.historyWindowLabel || "Live snapshot"} · {formatDateTime(summary?.generatedAt ?? null)}</span>
                  </div>
                </div>

                <div className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                  {summary?.components.map((component) => (
                    <ComponentRow key={component.id} component={component} />
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* History Log */}
          <section className="space-y-5">
            <h2 className="text-sm font-medium text-zinc-400 dark:text-zinc-500 px-1">History</h2>

            {isLoading ? (
              <div className="space-y-4">
                {[1, 2].map((i) => (
                  <div key={i} className="rounded-xl border border-zinc-200/80 dark:border-white/[0.08] p-6">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="h-4 w-40 rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                        <div className="h-5 w-16 rounded-full bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                      </div>
                      <div className="h-3 w-full rounded bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
                      <div className="h-3 w-24 rounded bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-10">
                {groupedIncidents.map(([date, incidents]) => (
                  <div key={date} className="relative">
                    <div className="sticky top-4 z-10 bg-white/80 dark:bg-[#030303]/90 backdrop-blur-md py-2 mb-5">
                      <h3 className="text-sm font-medium text-zinc-400 dark:text-zinc-500">{date}</h3>
                    </div>

                    <div className="space-y-4">
                      {incidents.map((incident) => (
                        <HistoryIncidentRow
                          key={incident.code}
                          incident={incident}
                          expanded={expandedIncidentCode === incident.code}
                          onToggle={() => setExpandedIncidentCode((current) => (current === incident.code ? null : incident.code))}
                          loading={incidentLoadingCode === incident.code}
                          details={incidentDetailsByCode[incident.code]}
                          error={incidentDetailsError[incident.code]}
                        />
                      ))}
                    </div>
                  </div>
                ))}

                {groupedIncidents.length === 0 && (
                  <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-8 text-center">
                    <p className="text-sm text-zinc-400 dark:text-zinc-500">No incidents recorded in the last 90 days.</p>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

      </main>

      {/* Footer */}
      <footer className="py-12 border-t border-border/40 bg-background relative z-10">
        <div className="container mx-auto px-6 max-w-7xl flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-3 text-sm text-muted-foreground font-medium">
            <ChalkLogo className="h-5 w-auto grayscale opacity-40" />
            <span>© {new Date().getFullYear()} Chalk</span>
          </div>
          <nav className="flex gap-6 md:gap-8 text-sm font-medium text-muted-foreground">
            <Link to="/" className="hover:text-foreground transition-colors">
              Home
            </Link>
            <a href="mailto:support@example.com" className="hover:text-foreground transition-colors">
              Support
            </a>
            <a href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function ComponentRow({ component }: { component: StatusComponent }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const meta = stateMeta(component.state);
  const detailText = component.message || component.description;
  const uptime = formatUptimeLabel(component.recentUptimePct, component.state);

  return (
    <div className="group flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-zinc-50/50 dark:hover:bg-white/[0.02]">
        <div className="min-w-0 flex items-start gap-3">
          <meta.Icon className={`h-5 w-5 shrink-0 mt-0.5 ${meta.iconClass}`} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{component.name}</span>
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-1 text-[11px] font-medium text-zinc-400 dark:text-zinc-600 hover:text-zinc-500 dark:hover:text-zinc-400 transition-colors"
              >
                <span>{isExpanded ? "Hide" : "Details"}</span>
                <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
              </button>
            </div>
            <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{detailText}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${meta.shortLabelClass}`}>
          {uptime}
        </span>
      </div>
      <div className="px-6 pb-4">
        <UptimeHistoryBars history={component.history} showLegend />
      </div>
      
      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          <div className="bg-zinc-50/60 dark:bg-white/[0.02] border-t border-zinc-100 dark:border-white/[0.06] px-10 py-5 space-y-4 transition-colors">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-xs text-zinc-400 dark:text-zinc-600">Current status</p>
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{detailText}</p>
              </div>
              <span className={`rounded-md px-2.5 py-1 text-[10px] font-medium ${meta.bannerClass}`}>{meta.shortLabel}</span>
            </div>
            <UptimeHistoryBars history={component.history} compact />
          </div>
        </div>
      </div>
    </div>
  );
}

function UptimeHistoryBars({ history, compact, showLegend }: { history: StatusHistoryBucket[]; compact?: boolean; showLegend?: boolean }) {
  const bars = useMemo(() => {
    if (history.length > 0) {
      return history;
    }
    const count = compact ? 40 : 60;
    return Array.from({ length: count }, () => ({ state: "unknown" as HealthState, timestamp: null, hasData: false }));
  }, [compact, history]);

  return (
    <div>
      <div className="flex gap-[2px] h-7 items-end">
        {bars.map((bar, i) => {
          let colorClass = "bg-zinc-200 dark:bg-zinc-800";
          if (bar.hasData) {
            colorClass = "bg-emerald-500/90 dark:bg-emerald-500/60";
            if (bar.state === "degraded") colorClass = "bg-amber-400 dark:bg-amber-500/60";
            if (bar.state === "outage") colorClass = "bg-rose-500/90 dark:bg-rose-500/60";
            if (bar.state === "maintenance") colorClass = "bg-sky-400 dark:bg-sky-500/60";
          }
          
          return (
            <div 
              key={i} 
              className={`flex-1 min-w-[3px] rounded-sm transition-[opacity,transform] hover:opacity-70 hover:scale-y-110 ${colorClass} ${compact ? "min-h-[6px]" : "min-h-[10px]"}`}
              title={historyBucketTitle(bar)}
            />
          );
        })}
      </div>
      {showLegend && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-medium text-zinc-400 dark:text-zinc-600">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/90 dark:bg-emerald-500/60" />Operational</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-amber-400 dark:bg-amber-500/60" />Degraded</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-rose-500/90 dark:bg-rose-500/60" />Outage</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-sky-400 dark:bg-sky-500/60" />Maintenance</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-zinc-200 dark:bg-zinc-800" />No data</span>
        </div>
      )}
    </div>
  );
}



function HistoryIncidentRow({
  incident,
  expanded,
  onToggle,
  loading,
  details,
  error,
}: {
  incident: StatusIncident;
  expanded: boolean;
  onToggle: () => void;
  loading: boolean;
  details: IncidentDetails | undefined;
  error: string | undefined;
}) {
  const isResolved = !!incident.resolvedAt;
  const isOutage = incident.severity === "outage";

  return (
    <div className="rounded-xl border border-zinc-200/80 dark:border-white/[0.08] bg-white dark:bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-4 p-6 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{incident.title}</h3>
            {isResolved ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/8 px-2 py-0.5 text-xs font-medium text-emerald-600/80 dark:text-emerald-400/80">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/80" />Resolved
              </span>
            ) : isOutage ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/8 px-2 py-0.5 text-xs font-medium text-rose-500/80 dark:text-rose-400/80">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500/80" />Outage
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/8 px-2 py-0.5 text-xs font-medium text-amber-600/80 dark:text-amber-400/80">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500/80" />Degraded
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-500 leading-relaxed max-w-2xl line-clamp-2">
            {incident.message || "No public summary provided."}
          </p>
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-600">
            <span>{isResolved ? `Resolved ${formatDateTime(incident.resolvedAt)}` : `Updated ${formatDateTime(incident.lastSeenAt || incident.firstSeenAt)}`}</span>
          </div>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
      </button>

      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          <div className="border-t border-zinc-100 dark:border-white/[0.05] bg-zinc-50/60 dark:bg-white/[0.02] px-6 py-5">
            <div className="border-l border-zinc-200 dark:border-zinc-800 ml-2 pl-6 py-1 space-y-5">
              {loading ? <p className="text-xs text-zinc-400 dark:text-zinc-600 animate-pulse">Retrieving incident timeline…</p> : null}
              {error ? <p className="text-xs text-rose-500 dark:text-rose-400">{error}</p> : null}

              {details?.events.map((event) => (
                <div key={event.id} className="relative">
                  <div className="absolute -left-[29px] top-1.5 h-2 w-2 rounded-full bg-zinc-200 dark:bg-zinc-700 ring-4 ring-zinc-50/60 dark:ring-[#030303]" />
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{toTitleCase(event.eventType)}</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-600">{formatDateTime(event.eventAt)}</span>
                  </div>
                  <p className="text-sm text-zinc-500 dark:text-zinc-500 leading-relaxed">{event.message}</p>
                </div>
              ))}
              {!loading && !error && details && details.events.length === 0 && (
                <p className="text-xs text-zinc-400 dark:text-zinc-600 italic">Historical timeline data unavailable for this record.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MaintenanceCard({ window, components }: { window: StatusMaintenance; components: StatusComponent[] }) {
  const now = Date.now();
  const isActive = window.status === "active";

  const startMs = window.startsAt ? new Date(window.startsAt).getTime() : Number.NaN;
  const endMs = window.endsAt ? new Date(window.endsAt).getTime() : Number.NaN;
  const hasValidStart = Number.isFinite(startMs);
  const hasValidEnd = Number.isFinite(endMs);

  // Proximity: within 24h of start, or already active
  const isImminent = isActive || (hasValidStart && startMs - now <= 24 * 60 * 60 * 1000 && startMs > now);
  const isPast = hasValidStart && startMs < now && !isActive;

  // Duration in hours
  const durationHours = useMemo(() => {
    if (!hasValidStart || !hasValidEnd) return null;
    const hours = Math.round((endMs - startMs) / (1000 * 60 * 60));
    return hours > 0 ? hours : null;
  }, [hasValidStart, hasValidEnd, startMs, endMs]);

  // Duration badge label
  const durationLabel = durationHours !== null
    ? durationHours < 1
      ? `${Math.round((endMs - startMs) / (1000 * 60))}m window`
      : durationHours === 1
        ? "1h window"
        : `${durationHours}h window`
    : null;

  // Relative time callout (not memoized — Date.now() changes every render)
  const relativeCallout = (() => {
    if (isActive) {
      if (hasValidEnd) {
        const minsLeft = Math.round((endMs - now) / (1000 * 60));
        if (minsLeft <= 0) return "Wrapping up";
        if (minsLeft < 60) return `Ends in ~${minsLeft}m`;
        const hrsLeft = Math.round(minsLeft / 60);
        return hrsLeft === 1 ? "Ends in ~1h" : `Ends in ~${hrsLeft}h`;
      }
      return "In progress";
    }
    if (isPast) return "Overdue";
    if (!hasValidStart) return isActive ? "In progress" : "Scheduled";

    const msUntilStart = startMs - now;
    if (msUntilStart <= 0) return "Starting soon";

    const minsUntil = Math.round(msUntilStart / (1000 * 60));
    if (minsUntil < 60) return `Starts in ${minsUntil}m`;
    const hrsUntil = Math.round(minsUntil / 60);
    if (hrsUntil < 24) return `Starts in ${hrsUntil}h`;
    const daysUntil = Math.round(hrsUntil / 24);
    return daysUntil === 1 ? "Tomorrow" : `In ${daysUntil} days`;
  })()

  // Visual intensity based on proximity
  const accentColor = isImminent || isActive
    ? "bg-sky-500/80"
    : isPast
      ? "bg-amber-500/80"
      : "bg-zinc-300 dark:bg-zinc-600";
  const borderColor = isImminent || isActive
    ? "border-sky-200/60 dark:border-sky-800/30"
    : isPast
      ? "border-amber-200/60 dark:border-amber-800/30"
      : "border-zinc-200/80 dark:border-white/[0.08]";
  const calloutColor = isImminent || isActive
    ? "text-sky-600 dark:text-sky-400"
    : isPast
      ? "text-amber-600 dark:text-amber-400"
      : "text-zinc-400 dark:text-zinc-500";

  return (
    <article className={`rounded-xl border ${borderColor} bg-white dark:bg-white/[0.02] overflow-hidden`}>
      {/* Accent strip — proximity-scaled */}
      <div className={`h-1 ${accentColor} ${isActive ? "animate-pulse" : ""}`} />

      <div className="p-6">
        {/* Title row */}
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{window.title}</h3>
          {isActive ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/8 px-2 py-0.5 text-xs font-medium text-sky-600/80 dark:text-sky-400/80">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500/80 animate-pulse" />
              In Progress
            </span>
          ) : isPast ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/8 px-2 py-0.5 text-xs font-medium text-amber-600/80 dark:text-amber-400/80">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500/80" />
              Overdue
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/8 px-2 py-0.5 text-xs font-medium text-zinc-500/80 dark:text-zinc-400/80">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-400/80" />
              Scheduled
            </span>
          )}
          {durationLabel && (
            <span className="rounded-md bg-zinc-100 dark:bg-zinc-800/60 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-500">
              {durationLabel}
            </span>
          )}
        </div>

        {/* Affected components — inline pills */}
        {window.componentIds.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {window.componentIds.slice(0, 4).map(id => {
              const comp = components.find(c => c.id === id);
              const compMeta = comp ? stateMeta(comp.state) : null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200/80 dark:border-white/[0.08] text-xs font-medium text-zinc-600 dark:text-zinc-400"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${compMeta?.dotClass ?? "bg-zinc-400"}`} />
                  {comp?.name || id}
                </span>
              );
            })}
            {window.componentIds.length > 4 && (
              <span className="text-xs text-zinc-400 dark:text-zinc-600">+{window.componentIds.length - 4} more</span>
            )}
          </div>
        )}

        {/* Relative time callout + absolute time range */}
        <div className="mt-4 space-y-1">
          <span className={`text-sm font-medium ${calloutColor}`}>
            {relativeCallout}
          </span>
          <div className="flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-600">
            <span>{formatShortDateTime(window.startsAt)} — {formatShortDateTime(window.endsAt)}</span>
          </div>
        </div>

        {/* Message — secondary */}
        {(window.message || window.summary) && (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-500 leading-relaxed">
            {window.message || window.summary}
          </p>
        )}
      </div>
    </article>
  );
}

function formatShortDateTime(value: string | null): string {
  if (!value) return "TBD";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "TBD";
  return new Intl.DateTimeFormat(undefined, { 
    month: "short", 
    day: "numeric", 
    hour: "numeric", 
    minute: "2-digit",
    hour12: true 
  }).format(parsed).toLowerCase();
}


function IncidentCard({ incident, expanded, onToggle, loading, details, error, isActive }: { incident: StatusIncident; expanded: boolean; onToggle: () => void; loading: boolean; details: IncidentDetails | undefined; error: string | undefined; isActive?: boolean }) {
  const duration = useMemo(() => {
    if (!incident.resolvedAt || !incident.firstSeenAt) return null;
    const start = new Date(incident.firstSeenAt).getTime();
    const end = new Date(incident.resolvedAt).getTime();
    const diff = Math.floor((end - start) / (1000 * 60));
    return diff > 0 ? diff : null;
  }, [incident]);

  const isOutage = incident.severity === "outage";

  return (
    <article className="rounded-xl border border-zinc-200/80 dark:border-white/[0.08] bg-white dark:bg-white/[0.02] overflow-hidden">
      <button type="button" onClick={onToggle} className="flex w-full items-start justify-between gap-4 p-6 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{incident.title}</h3>
            {isActive ? (
              isOutage ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/8 px-2 py-0.5 text-xs font-medium text-rose-500/80 dark:text-rose-400/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500/80 animate-pulse" />Outage
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/8 px-2 py-0.5 text-xs font-medium text-amber-600/80 dark:text-amber-400/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500/80 animate-pulse" />Degraded
                </span>
              )
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/8 px-2 py-0.5 text-xs font-medium text-emerald-600/80 dark:text-emerald-400/80">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/80" />Resolved
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-500 leading-relaxed max-w-2xl">{incident.message || "No public summary provided."}</p>

          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-600">
            <span>{isActive ? `Updated ${formatDateTime(incident.lastSeenAt || incident.firstSeenAt)}` : `Resolved ${formatDateTime(incident.resolvedAt)}`}</span>
            {duration && <span>· {duration}m duration</span>}
          </div>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
      </button>

      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          <div className="border-t border-zinc-100 dark:border-white/[0.05] bg-zinc-50/60 dark:bg-white/[0.02] px-6 py-5">
            <div className="border-l border-zinc-200 dark:border-zinc-800 ml-2 pl-6 py-1 space-y-5">
              {loading ? <p className="text-xs text-zinc-400 dark:text-zinc-600 animate-pulse">Retrieving incident timeline…</p> : null}
              {error ? <p className="text-xs text-rose-500 dark:text-rose-400">{error}</p> : null}

              {details?.events.map((event) => (
                <div key={event.id} className="relative">
                  <div className="absolute -left-[29px] top-1.5 h-2 w-2 rounded-full bg-zinc-200 dark:bg-zinc-700 ring-4 ring-zinc-50/60 dark:ring-[#030303]" />
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{toTitleCase(event.eventType)}</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-600">{formatDateTime(event.eventAt)}</span>
                  </div>
                  <p className="text-sm text-zinc-500 dark:text-zinc-500 leading-relaxed">{event.message}</p>
                </div>
              ))}
              {!loading && !error && details && details.events.length === 0 && (
                <p className="text-xs text-zinc-400 dark:text-zinc-600 italic">Historical timeline data unavailable for this record.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function StatusErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="font-app flex min-h-screen items-center justify-center bg-white dark:bg-[#030303] p-6">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 dark:bg-rose-950/20 mb-4">
          <XCircle className="h-6 w-6 text-rose-400" />
        </div>
        <h1 className="text-xl font-medium text-zinc-800 dark:text-zinc-200">Telemetry Lost</h1>
        <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-600">{message}</p>
        <button type="button" onClick={onRetry} className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-zinc-900 dark:bg-white px-6 text-sm font-medium text-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200">
          Reconnect
        </button>
      </div>
    </div>
  );
}

function stateMeta(state: HealthState) {
  switch (state) {
    case "operational":
      return {
        label: "Operational",
        shortLabel: "Operational",
        headline: "We're fully operational",
        subtext: "We're not aware of any issues affecting our systems.",
        Icon: CheckCircle2,
        bannerClass: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
        bannerBarClass: "bg-emerald-50/80 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-800/30 text-emerald-900 dark:text-emerald-300",
        heroGradientClass: "from-emerald-50/40 dark:from-emerald-950/20",
        heroBorderClass: "border-emerald-200/60 dark:border-emerald-800/30",
        iconClass: "text-emerald-500",
        dotClass: "bg-emerald-500",
        shortLabelClass: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
      };
    case "degraded":
      return {
        label: "Degraded",
        shortLabel: "Degraded",
        headline: "Some systems are experiencing issues",
        subtext: "We're actively investigating degraded performance affecting parts of Chalk.",
        Icon: AlertTriangle,
        bannerClass: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
        bannerBarClass: "bg-amber-50/80 dark:bg-amber-950/30 border-amber-200/60 dark:border-amber-800/30 text-amber-900 dark:text-amber-300",
        heroGradientClass: "from-amber-50/50 dark:from-amber-950/30",
        heroBorderClass: "border-amber-200/60 dark:border-amber-800/30",
        iconClass: "text-amber-500",
        dotClass: "bg-amber-500",
        shortLabelClass: "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
      };
    case "outage":
      return {
        label: "Outage",
        shortLabel: "Outage",
        headline: "Chalk is experiencing an outage",
        subtext: "One or more services are unexpectedly unavailable. Our team is actively working to restore full service.",
        Icon: XCircle,
        bannerClass: "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400",
        bannerBarClass: "bg-rose-50/80 dark:bg-rose-950/30 border-rose-200/60 dark:border-rose-800/30 text-rose-900 dark:text-rose-300",
        heroGradientClass: "from-rose-50/50 dark:from-rose-950/30",
        heroBorderClass: "border-rose-200/60 dark:border-rose-800/30",
        iconClass: "text-rose-500",
        dotClass: "bg-rose-500",
        shortLabelClass: "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400",
      };
    case "maintenance":
      return {
        label: "Maintenance",
        shortLabel: "Maint.",
        headline: "Scheduled maintenance in progress",
        subtext: "Planned maintenance is underway. Some parts of Chalk may be temporarily unavailable until this work is complete.",
        Icon: Wrench,
        bannerClass: "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-400",
        bannerBarClass: "bg-sky-50/80 dark:bg-sky-950/30 border-sky-200/60 dark:border-sky-800/30 text-sky-900 dark:text-sky-300",
        heroGradientClass: "from-sky-50/50 dark:from-sky-950/30",
        heroBorderClass: "border-sky-200/60 dark:border-sky-800/30",
        iconClass: "text-sky-500",
        dotClass: "bg-sky-500",
        shortLabelClass: "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-400",
      };
    default:
      return {
        label: "Unknown",
        shortLabel: "Unknown",
        headline: "Status Unknown",
        subtext: "We're currently unable to retrieve the latest system heartbeat.",
        Icon: Info,
        bannerClass: "bg-zinc-50 text-zinc-700 dark:bg-zinc-950/30 dark:text-zinc-400",
        bannerBarClass: "bg-zinc-50/80 dark:bg-zinc-950/30 border-zinc-200/60 dark:border-zinc-800/30 text-zinc-900 dark:text-zinc-300",
        heroGradientClass: "from-zinc-50/40 dark:from-zinc-950/20",
        heroBorderClass: "border-zinc-200/60 dark:border-zinc-800/30",
        iconClass: "text-zinc-400",
        dotClass: "bg-zinc-400",
        shortLabelClass: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
      };
  }
}

function normalizeStatusSummary(payload: unknown): StatusSummary {
  const record = asRecord(payload);
  return {
    generatedAt: readTimestamp(record.generated_at),
    overall: normalizeHealthState(readString(record.overall)),
    historyWindowLabel: readString(record.history_window_label) || "Live snapshot",
    components: toArray(record.components).map((item, index) => {
      const component = asRecord(item);
      return {
        id: readString(component.id) || `component-${index + 1}`,
        name: readString(component.name) || `Component ${index + 1}`,
        description: readString(component.description) || "No description available.",
        state: normalizeHealthState(readString(component.state)),
        message: readString(component.message) || "",
        recentUptimePct: readNumber(component.recent_uptime_pct),
        history: toArray(component.history).map((bucket) => {
          const row = asRecord(bucket);
          return {
            state: normalizeHealthState(readString(row.state)),
            timestamp: readTimestamp(row.timestamp),
            hasData: readBoolean(row.has_data),
          };
        }),
      };
    }),
    activeIncidents: toArray(record.active_incidents).map(normalizeIncident),
    recentIncidents: toArray(record.recent_incidents).map(normalizeIncident),
    maintenance: toArray(record.maintenance).map((item, index) => {
      const window = asRecord(item);
      const startsAt = readTimestamp(window.starts_at);
      const endsAt = readTimestamp(window.ends_at);
      return {
        id: readString(window.id) || `maintenance-${index + 1}`,
        title: readString(window.title) || "Maintenance window",
        message: readString(window.public_message) || "",
        summary: readString(window.summary) || "",
        status: deriveMaintenanceStatus(readString(window.status), startsAt, endsAt),
        startsAt,
        endsAt,
        componentIds: toStringArray(window.component_ids),
      };
    }),
  };
}

function normalizeIncidentDetails(payload: unknown): IncidentDetails {
  const record = asRecord(payload);
  const eventRows = toArray(record.events).map((item, index) => {
    const event = asRecord(item);
    return {
      id: readString(event.id) || `event-${index + 1}`,
      eventType: readString(event.event_type) || "update",
      message: readString(event.message) || "No event details available.",
      eventAt: readTimestamp(event.event_at) || readTimestamp(event.created_at),
    };
  });
  return {
    incident: normalizeIncident(record.incident),
    events: eventRows,
  };
}

function normalizeIncident(value: unknown): StatusIncident {
  const incident = asRecord(value);
  const code = readString(incident.incident_code) || "incident";
  return {
    code,
    title: readString(incident.public_title) || readString(incident.title) || code,
    message: readString(incident.public_message) || readString(incident.summary) || "",
    severity: readString(incident.severity) || "unknown",
    status: readString(incident.status) || "open",
    firstSeenAt: readTimestamp(incident.first_seen_at) || readTimestamp(incident.created_at),
    lastSeenAt: readTimestamp(incident.last_seen_at) || readTimestamp(incident.updated_at),
    resolvedAt: readTimestamp(incident.resolved_at),
    componentIds: toStringArray(incident.component_ids),
  };
}

function formatDateTime(value: string | null) {
  if (!value) return "Unknown time";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Unknown time";
  const local = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
  const utc = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
  return `${local} (UTC ${utc})`;
}

function formatDateKey(value: string | null) {
  if (!value) return "Unknown Date";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Unknown Date";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(parsed);
}

function normalizeHealthState(raw: string) {
  switch (raw) {
    case "operational":
    case "degraded":
    case "outage":
    case "maintenance":
      return raw;
    default:
      return "unknown";
  }
}

function readTimestamp(value: unknown) {
  const direct = readString(value);
  if (direct && !Number.isNaN(new Date(direct).valueOf())) {
    return direct;
  }
  const objectValue = asRecord(value);
  const valid = objectValue.Valid ?? objectValue.valid;
  if (valid === false) {
    return null;
  }
  const nested = readString(objectValue.Time) || readString(objectValue.time);
  if (nested && !Number.isNaN(new Date(nested).valueOf())) {
    return nested;
  }
  return null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown) {
  return value === true;
}

function toStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toTitleCase(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");
}

function statusCardHeadline(state: HealthState) {
  switch (state) {
    case "outage":
      return "Service outage in progress";
    case "degraded":
      return "Service degradation in progress";
    case "maintenance":
      return "Active maintenance";
    case "operational":
      return "All systems operational";
    default:
      return "Live service status";
  }
}

function formatUptimeLabel(recentUptimePct: number | null, state: HealthState) {
  switch (state) {
    case "outage":
      return "Unavailable";
    case "degraded":
      return "Degraded";
    case "maintenance":
      return "Maintenance";
    default:
      break;
  }
  if (recentUptimePct === null) {
    return "Monitoring live";
  }
  return `${recentUptimePct.toFixed(recentUptimePct % 1 === 0 ? 0 : 1)}% uptime`;
}

function historyBucketTitle(bucket: StatusHistoryBucket) {
  const status = bucket.hasData ? toTitleCase(bucket.state) : "No data";
  return bucket.timestamp ? `${status} · ${formatDateTime(bucket.timestamp)}` : status;
}

function deriveMaintenanceStatus(status: string, startsAt: string | null, endsAt: string | null) {
  const now = Date.now();
  const startMs = startsAt ? new Date(startsAt).getTime() : Number.NaN;
  const endMs = endsAt ? new Date(endsAt).getTime() : Number.NaN;
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= now && now < endMs) {
    return "active";
  }
  return status || "scheduled";
}
