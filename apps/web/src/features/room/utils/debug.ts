/**
 * Room Debug Logger
 *
 * Provides two levels of logging:
 * - info(): Glanceable, one-line status updates with emoji icons
 * - debug(): Verbose state dumps for deep debugging
 *
 * All logs are prefixed with [Room] for easy filtering in console
 */

const COLORS = {
  // Actions
  action: "color: #8B5CF6; font-weight: bold", // purple - user actions
  event: "color: #10B981; font-weight: bold", // green - incoming events
  state: "color: #3B82F6; font-weight: bold", // blue - state changes
  error: "color: #EF4444; font-weight: bold", // red - errors
  warn: "color: #F59E0B; font-weight: bold", // orange - warnings
  lifecycle: "color: #EC4899; font-weight: bold", // pink - mount/unmount
  navigation: "color: #06B6D4; font-weight: bold", // cyan - navigation
  media: "color: #84CC16; font-weight: bold", // lime - media events
  sdk: "color: #A855F7; font-weight: bold", // violet - SDK calls
  render: "color: #6B7280", // gray - render cycles
} as const;

const ICONS = {
  // Status
  success: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",

  // Actions
  click: "👆",
  toggle: "🔄",
  send: "📤",
  receive: "📥",

  // Media
  mic: "🎤",
  micOff: "🔇",
  video: "📹",
  videoOff: "📷",
  screen: "🖥️",

  // Room
  join: "🚪",
  leave: "🚶",
  participant: "👤",
  participants: "👥",

  // Features
  chat: "💬",
  reaction: "😊",
  hand: "✋",
  recording: "🔴",
  notification: "🔔",

  // State
  loading: "⏳",
  connected: "🟢",
  disconnected: "🔴",
  redirect: "↪️",

  // Lifecycle
  mount: "🔌",
  unmount: "🔌",
  effect: "⚡",
  cleanup: "🧹",

  // Debug
  dump: "📋",
  timer: "⏱️",
} as const;

type LogCategory = keyof typeof COLORS;

class RoomDebugger {
  private enabled = true;
  private verboseMode = true;
  private renderCount = 0;
  private lastRenderTime = 0;
  private componentName = "Room";

  constructor() {
    // Check if debug mode is enabled via query param or localStorage
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      this.enabled = urlParams.get("debug") !== "false";
      this.verboseMode = urlParams.get("verbose") === "true" || localStorage.getItem("chalk_debug_verbose") === "true";
    }
  }

  /**
   * Set the component name for log prefixes
   */
  setComponent(name: string) {
    this.componentName = name;
  }

  /**
   * Glanceable one-line log with icon
   * Use for: actions, events, state changes
   */
  info(icon: keyof typeof ICONS, message: string, category: LogCategory = "state") {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const emoji = ICONS[icon];

    console.log(`%c${prefix} ${emoji} ${message}`, COLORS[category]);
  }

  /**
   * Action log - for user-initiated actions
   */
  action(icon: keyof typeof ICONS, action: string, details?: string) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const emoji = ICONS[icon];
    const msg = details ? `${action} → ${details}` : action;

    console.log(`%c${prefix} ${emoji} ACTION: ${msg}`, COLORS.action);
  }

  /**
   * Event log - for incoming events from SDK/room
   */
  event(icon: keyof typeof ICONS, eventName: string, details?: string) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const emoji = ICONS[icon];
    const msg = details ? `${eventName} → ${details}` : eventName;

    console.log(`%c${prefix} ${emoji} EVENT: ${msg}`, COLORS.event);
  }

  /**
   * SDK call log
   */
  sdk(method: string, args?: Record<string, unknown>) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const argsStr = args ? ` ${JSON.stringify(args)}` : "";

    console.log(`%c${prefix} 🔧 SDK: ${method}()${argsStr}`, COLORS.sdk);
  }

  /**
   * Media state change
   */
  media(type: "mic" | "video" | "screen", enabled: boolean, details?: string) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const icon = enabled ? (type === "mic" ? "🎤" : type === "video" ? "📹" : "🖥️") : type === "mic" ? "🔇" : type === "video" ? "📷" : "🖥️";
    const state = enabled ? "ON" : "OFF";
    const extra = details ? ` (${details})` : "";

    console.log(`%c${prefix} ${icon} MEDIA: ${type.toUpperCase()} ${state}${extra}`, COLORS.media);
  }

  /**
   * Navigation log
   */
  nav(action: "redirect" | "navigate", to: string, reason?: string) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const icon = action === "redirect" ? "↪️" : "🧭";
    const reasonStr = reason ? ` (${reason})` : "";

    console.log(`%c${prefix} ${icon} NAV: ${action.toUpperCase()} to ${to}${reasonStr}`, COLORS.navigation);
  }

  /**
   * Lifecycle log
   */
  lifecycle(event: "mount" | "unmount" | "effect" | "cleanup", hookName?: string) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const icons = { mount: "🔌", unmount: "🔌", effect: "⚡", cleanup: "🧹" };
    const labels = { mount: "MOUNT", unmount: "UNMOUNT", effect: "EFFECT", cleanup: "CLEANUP" };
    const hookStr = hookName ? ` [${hookName}]` : "";

    console.log(`%c${prefix} ${icons[event]} ${labels[event]}${hookStr}`, COLORS.lifecycle);
  }

  /**
   * Error log with full details
   */
  error(context: string, error: unknown, additionalInfo?: Record<string, unknown>) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.log(`%c${prefix} ❌ ERROR in ${context}: ${errorMsg}`, COLORS.error);

    if (this.verboseMode && additionalInfo) {
      console.log(`%c${prefix}    └─ Details:`, COLORS.error, additionalInfo);
    }

    if (error instanceof Error && error.stack) {
      console.log(`%c${prefix}    └─ Stack:`, COLORS.error, error.stack);
    }
  }

  /**
   * Warning log
   */
  warn(context: string, message: string, data?: unknown) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;

    console.log(`%c${prefix} ⚠️ WARN [${context}]: ${message}`, COLORS.warn);

    if (this.verboseMode && data !== undefined) {
      console.log(`%c${prefix}    └─ Data:`, COLORS.warn, data);
    }
  }

  /**
   * Verbose state dump - only in verbose mode
   * Use for: full state inspection, debugging complex issues
   */
  debug(label: string, data: Record<string, unknown>) {
    if (!this.enabled || !this.verboseMode) return;

    const prefix = `[${this.componentName}]`;

    console.groupCollapsed(`%c${prefix} 📋 DEBUG: ${label}`, COLORS.state);

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "object" && value !== null) {
        console.log(`%c  ${key}:`, "color: #6B7280; font-weight: bold", value);
      } else {
        console.log(`%c  ${key}: %c${String(value)}`, "color: #6B7280", "color: #374151");
      }
    }

    console.groupEnd();
  }

  /**
   * State change log with before/after
   */
  stateChange<T>(stateName: string, prevValue: T, newValue: T) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;

    console.log(`%c${prefix} 🔄 STATE: ${stateName} changed`, COLORS.state, { from: prevValue, to: newValue });
  }

  /**
   * Track render count and performance
   */
  render(reason?: string) {
    if (!this.enabled) return;

    this.renderCount++;
    const now = performance.now();
    const timeSinceLastRender = this.lastRenderTime ? (now - this.lastRenderTime).toFixed(1) : "N/A";
    this.lastRenderTime = now;

    const prefix = `[${this.componentName}]`;
    const reasonStr = reason ? ` (${reason})` : "";

    console.log(`%c${prefix} 🎨 RENDER #${this.renderCount}${reasonStr} [+${timeSinceLastRender}ms]`, COLORS.render);
  }

  /**
   * Group related logs together
   */
  group(label: string, fn: () => void) {
    if (!this.enabled) return fn();

    const prefix = `[${this.componentName}]`;
    console.groupCollapsed(`%c${prefix} 📁 ${label}`, COLORS.state);
    fn();
    console.groupEnd();
  }

  /**
   * Table display for arrays of objects
   */
  table(label: string, data: unknown[]) {
    if (!this.enabled || !this.verboseMode) return;

    const prefix = `[${this.componentName}]`;
    console.log(`%c${prefix} 📊 ${label}:`, COLORS.state);
    console.table(data);
  }

  /**
   * Time a function execution
   */
  async time<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    if (!this.enabled) return fn();

    const prefix = `[${this.componentName}]`;
    const start = performance.now();

    console.log(`%c${prefix} ⏱️ START: ${label}`, COLORS.state);

    try {
      const result = await fn();
      const duration = (performance.now() - start).toFixed(2);
      console.log(`%c${prefix} ⏱️ END: ${label} [${duration}ms]`, COLORS.state);
      return result;
    } catch (error) {
      const duration = (performance.now() - start).toFixed(2);
      console.log(`%c${prefix} ⏱️ FAIL: ${label} [${duration}ms]`, COLORS.error);
      throw error;
    }
  }

  /**
   * Create a sub-logger for a specific component/hook
   */
  createChild(componentName: string): RoomDebugger {
    const child = new RoomDebugger();
    child.setComponent(componentName);
    child.enabled = this.enabled;
    child.verboseMode = this.verboseMode;
    return child;
  }

  /**
   * Summary log for quick state overview
   */
  summary(data: { roomId?: string; isConnected?: boolean; participants?: number; localParticipant?: string; mediaState?: { video: boolean; audio: boolean; screen: boolean }; activePanel?: string | null; sessionDuration?: number }) {
    if (!this.enabled) return;

    const prefix = `[${this.componentName}]`;
    const status = data.isConnected ? "🟢" : "🔴";
    const media = data.mediaState ? `[${data.mediaState.video ? "📹" : "📷"}${data.mediaState.audio ? "🎤" : "🔇"}${data.mediaState.screen ? "🖥️" : ""}]` : "";
    const panel = data.activePanel ? `[${data.activePanel}]` : "";

    console.log(`%c${prefix} ${status} SUMMARY: Room=${data.roomId} | ${data.participants || 0} participants | ${media} ${panel}`, COLORS.state);
  }
}

// Singleton instance
export const roomDebug = new RoomDebugger();

// Export for creating child loggers
export const createDebugger = (componentName: string) => roomDebug.createChild(componentName);

// Convenience exports
export type { LogCategory };
