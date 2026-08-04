import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DashboardAPIError, getAccount, listAllAccountTenants, logoutAccount, type AccountTenant, type DashboardAccount } from "../../lib/dashboard-api";

type DashboardAccountValue = {
  account: DashboardAccount;
  tenants: AccountTenant[];
  current: AccountTenant;
  selectTenant: (tenantID: string) => void;
  signOut: () => Promise<void>;
};

const DashboardAccountContext = createContext<DashboardAccountValue | null>(null);
const tenantHintKey = "chalk.tenant-hint";

export function DashboardAccountGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ account: DashboardAccount; tenants: AccountTenant[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTenantID, setSelectedTenantID] = useState<string | null>(() => (typeof window === "undefined" ? null : window.localStorage.getItem(tenantHintKey)));

  useEffect(() => {
    let active = true;
    void Promise.all([getAccount(), listAllAccountTenants()])
      .then(([account, tenants]) => {
        if (!active) return;
        if (tenants.length === 0) {
          void navigate({ to: "/onboarding", replace: true });
          return;
        }
        setState({ account, tenants });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof DashboardAPIError && cause.status === 401) {
          void navigate({ to: "/sign-in", replace: true });
          return;
        }
        setError(cause instanceof Error ? cause.message : "The dashboard could not load");
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  const current = state?.tenants.find((item) => item.tenant.id === selectedTenantID) ?? state?.tenants[0];
  const value = useMemo<DashboardAccountValue | null>(() => {
    if (!state || !current) return null;
    return {
      ...state,
      current,
      selectTenant(tenantID) {
        if (!state.tenants.some((item) => item.tenant.id === tenantID)) return;
        window.localStorage.setItem(tenantHintKey, tenantID);
        setSelectedTenantID(tenantID);
      },
      async signOut() {
        await logoutAccount();
        window.localStorage.removeItem(tenantHintKey);
        await navigate({ to: "/sign-in", replace: true });
      },
    };
  }, [current, navigate, state]);

  if (error) {
    return (
      <main className="dashboard-gate-state">
        <p className="eyebrow">Dashboard unavailable</p>
        <h1>We could not load your Account.</h1>
        <p>{error}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  if (!value) return <DashboardLoading />;
  return <DashboardAccountContext.Provider value={value}>{children}</DashboardAccountContext.Provider>;
}

export function useDashboardAccount(): DashboardAccountValue {
  const value = useContext(DashboardAccountContext);
  if (!value) throw new Error("Dashboard Account is unavailable");
  return value;
}

function DashboardLoading() {
  return (
    <main className="dashboard-gate-state" aria-live="polite">
      <span className="dashboard-loading-mark">C</span>
      <p>Preparing your dashboard…</p>
    </main>
  );
}
