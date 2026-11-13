import { CallLimbo, type PreJoinJoinOptions } from "@q9labsai/chalk-react";
import { useMemo, useRef } from "react";
import { createPublicInviteClient } from "../../lib/chalk-access";
import { reportCredentialExpiredReason } from "../../lib/problem-reports";
import { useTheme } from "../../lib/theme-context";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { warmCall, type CallSurface } from "./call-surface";
import type { Entrance } from "./entrance-machine";
import { PreJoin } from "./pre-join/PreJoin";
import { useSpaceReport } from "./report-problem";
import { useSpaceEntrance, type SpaceRoute } from "./space-entrance";
import { useVisitor } from "./visitor";

type SpacePageProps = {
  readonly slug?: string;
  readonly inviteCode?: string;
  readonly navigatePublicSpace?: SpaceRoute["navigatePublicSpace"];
};
type ColorScheme = ReturnType<typeof useTheme>["mode"];

export function SpacePage(props: SpacePageProps = {}) {
  const { mode } = useTheme();
  return (
    <div data-chalk data-chalk-theme={mode} className="flex h-dvh min-h-0 w-full flex-col overflow-hidden">
      <div className="mx-auto w-full max-w-5xl shrink-0 px-4">
        <PrivacyNotice overCall />
      </div>
      <div className="relative min-h-0 flex-1">
        <SpaceEntry {...props} />
      </div>
    </div>
  );
}

function SpaceEntry({ slug, inviteCode, navigatePublicSpace = replacePublicSpaceHistory }: SpacePageProps) {
  const { mode } = useTheme();
  const client = useMemo(() => createPublicInviteClient(), []);
  const visitor = useVisitor(slug ?? inviteCode);
  const { entrance, callName, callSurface, start, cancel, onEnded, goHome } = useSpaceEntrance(client, { slug, inviteCode, navigatePublicSpace }, visitor);
  const report = useSpaceReport(entrance);
  const reportFocusScope = useRef<HTMLDivElement>(null);
  const settings = visitor.callSettings;
  const surface = () => {
    if (entrance.phase === "ended" && callSurface) {
      const { call, attempt } = entrance;
      return <EndedCallView entrance={entrance} StatusSurface={callSurface.StatusSurface} mode={mode} onReportProblem={report.available && call.reportProblem && !report.expired ? () => report.setOpen(true) : undefined} onRejoin={() => start(settings)} onHome={() => goHome(call, attempt)} />;
    }
    if (entrance.phase === "admitted" && entrance.callUi === "ready" && callSurface) {
      const { joined } = entrance;
      const { LocalSpace } = callSurface;
      return (
        <LocalSpace
          admission={joined}
          reportsAvailable={report.available}
          reportUnavailableReason={report.expired ? reportCredentialExpiredReason : undefined}
          onOpenReportProblem={report.openFromCall}
          displayName={settings.displayName}
          defaults={settings}
          spaceName={joined.spaceName}
          inviteLink={joined.inviteLink}
          onEnded={onEnded}
        />
      );
    }
    const onDisplayNameChange = (name: string) => {
      visitor.editName(name);
      warmCall();
    };
    return (
      <main data-chalk data-chalk-theme={mode} className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="min-h-0 flex-1">
          <EntranceView entrance={entrance} mode={mode} callName={callName} displayName={visitor.displayName} onDisplayNameChange={onDisplayNameChange} onJoin={(devices) => start({ ...devices, displayName: visitor.displayName }, true)} onRetry={() => start()} onCancel={() => void cancel()} />
        </div>
      </main>
    );
  };
  return (
    <div ref={reportFocusScope} className="contents">
      {surface()}
      {report.send && callSurface ? <callSurface.ReportProblemDialog unavailableReason={report.unavailableReason} diagnostics={report.diagnostics} focusScope={reportFocusScope} open={report.open} onClose={() => report.setOpen(false)} onReportProblem={report.send} colorScheme={mode} /> : null}
    </div>
  );
}

type EndedCallViewProps = {
  readonly entrance: Extract<Entrance, { phase: "ended" }>;
  readonly StatusSurface: CallSurface["StatusSurface"];
  readonly mode: ColorScheme;
  readonly onReportProblem: (() => void) | undefined;
  readonly onRejoin: () => void;
  readonly onHome: () => void;
};

/** The leave screen: why the call ended, Rejoin and Home. */
function EndedCallView({ entrance: { call, rejoining, failure }, StatusSurface, mode, onReportProblem, onRejoin, onHome }: EndedCallViewProps) {
  return (
    <main className="relative h-full">
      <StatusSurface
        phase={call.phase}
        episodeEndReason={call.endReason}
        endAction={!call.hostCanExtend ? { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") } : undefined}
        callName={call.callName}
        errorCode={call.failure?.code}
        sync={call.failure?.sync}
        theme={{ colorScheme: mode }}
        onReportProblem={onReportProblem}
        rejoinDisabled={rejoining}
        onRejoin={onRejoin}
        onHome={onHome}
      />
      {failure ? (
        <p role="alert" className="absolute inset-x-6 bottom-6 text-center text-sm">
          {failure.message}
        </p>
      ) : null}
    </main>
  );
}

type EntranceViewProps = {
  readonly entrance: Entrance;
  readonly mode: ColorScheme;
  readonly callName: string | undefined;
  readonly displayName: string;
  readonly onDisplayNameChange: (name: string) => void;
  readonly onJoin: (devices: PreJoinJoinOptions) => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
};

/** Everything before the call UI takes over: the name and device step, the lobby, and the messages in between. */
function EntranceView({ entrance, mode, callName, displayName, onDisplayNameChange, onJoin, onRetry, onCancel }: EntranceViewProps) {
  const theme = { colorScheme: mode };
  const joining = <CallLimbo theme={theme} spaceName={callName} message={`Joining ${callName ?? "the call"}…`} />;
  switch (entrance.phase) {
    case "waiting": {
      const { waiting, failure, cancelling } = entrance;
      return (
        <CallLimbo
          theme={theme}
          spaceName={waiting.spaceName}
          message={failure?.message ?? `Asking to join ${waiting.spaceName ?? "the call"}`}
          detail={failure ? undefined : "The host will let you in."}
          joiningAs={failure ? undefined : displayName.trim()}
          action={{ label: "Cancel", onClick: onCancel, disabled: cancelling }}
        />
      );
    }
    case "failed": {
      const { failure, restarting } = entrance;
      return <CallLimbo theme={theme} spaceName={callName} message={failure.message} glyph={failure.reason} action={failure.retryable ? { label: failure.retryLabel ?? "Ask again", onClick: onRetry, disabled: restarting } : undefined} />;
    }
    case "idle":
    case "arriving":
    case "admitted":
      return entrance.stepOpen ? <PreJoin spaceName={callName} displayName={displayName} onDisplayNameChange={onDisplayNameChange} joining={entrance.phase !== "idle"} onJoin={onJoin} /> : joining;
    case "ended":
      return joining;
  }
}

async function replacePublicSpaceHistory(_canonicalSlug: string, inviteLink: string): Promise<void> {
  globalThis.history?.replaceState(globalThis.history.state, "", inviteLink);
}
