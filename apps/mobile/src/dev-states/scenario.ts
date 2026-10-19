import type { ScenarioCode } from "./codes";

const screens = { A1: "home", A2: "call", A3: "left", A4: "ended", A5: "failed", A6: "removed", A7: "full", A8: "splash", T1: "joining", T2: "name", T3: "knocking", T4: "refused", T5: "reconnecting", T6: "hold" } as const;
function isScreenCode(code: ScenarioCode): code is keyof typeof screens {
  return code in screens;
}

/** Matches the states lane's dev-only CallFrame seam; joining/reconnecting use connection.status. */
export function callStateForScreen(screen: string): { callState?: "knocking" | "refused" | "hold" | "full" | "left" | "ended" | "failed" | "removed" } {
  switch (screen) {
    case "knocking":
    case "refused":
    case "hold":
    case "full":
    case "left":
    case "ended":
    case "failed":
    case "removed":
      return { callState: screen };
    default:
      return {};
  }
}

/** UI-only states remain explicit: SpaceSnapshot has no name/knock/hold variants. */
export function scenarioForCodes(codes: readonly ScenarioCode[]) {
  const screenCode = codes.findLast(isScreenCode);
  const theme: "dark" | "light" = codes.includes("V2") ? "light" : "dark";
  return {
    codes,
    screen: screenCode ? screens[screenCode] : "call",
    theme,
    layout: codes.includes("G2") ? "grid" : "spotlight",
    aspect: codes.includes("S4") ? 9 / 16 : codes.includes("S3") ? 21 / 9 : codes.includes("S2") ? 4 / 3 : 16 / 9,
    sharer: codes.includes("W2") ? "person-0" : "person-1",
    speaking: { participantId: "person-1", level: 0.65 },
    conditions: codes.filter((code) => code.startsWith("K")),
    events: codes.filter((code) => code.startsWith("F")),
  };
}
