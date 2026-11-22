import { createContext } from "react";

/**
 * True while the call sits in limbo under the reconnecting, offline or connection-lost card. Sheets close under it, so the
 * card is the one thing on screen, and a sheet that was open comes back where it was when the call returns.
 */
export const CallLimboContext = createContext(false);
