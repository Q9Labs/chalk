import type { SqlStorage } from "cloudflare:workers";

export type MeetingRecord = {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly hostBrowserSessionId: string;
  readonly logId: string;
  readonly sessionId?: string;
};

export type BrowserRecord = {
  readonly browserSessionId: string;
  readonly displayName: string;
  readonly isHost: boolean;
  readonly participantGeneration?: number;
  readonly participantSessionId?: string;
};

type MeetingRow = {
  readonly created_at: number;
  readonly expires_at: number;
  readonly host_browser_session_id: string;
  readonly log_id: string;
  readonly session_id: string | null;
};

type BrowserRow = {
  readonly browser_session_id: string;
  readonly display_name: string;
  readonly is_host: number;
  readonly participant_generation: number | null;
  readonly participant_session_id: string | null;
};

export class MeetingStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS meeting (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      log_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      session_id TEXT,
      host_browser_session_id TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS browser_sessions (
      browser_session_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      is_host INTEGER NOT NULL CHECK (is_host IN (0, 1)),
      participant_session_id TEXT,
      participant_generation INTEGER,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )`);
  }

  meeting(): MeetingRecord | undefined {
    const row = this.sql.exec<MeetingRow>("SELECT log_id, created_at, expires_at, session_id, host_browser_session_id FROM meeting WHERE singleton = 1").toArray()[0];
    if (!row) return undefined;
    return {
      logId: row.log_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      hostBrowserSessionId: row.host_browser_session_id,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
    };
  }

  createMeeting(input: MeetingRecord): void {
    this.sql.exec("INSERT INTO meeting (singleton, log_id, created_at, expires_at, host_browser_session_id) VALUES (1, ?, ?, ?, ?)", input.logId, input.createdAt, input.expiresAt, input.hostBrowserSessionId);
  }

  browser(browserSessionId: string): BrowserRecord | undefined {
    const row = this.sql.exec<BrowserRow>("SELECT browser_session_id, display_name, is_host, participant_session_id, participant_generation FROM browser_sessions WHERE browser_session_id = ?", browserSessionId).toArray()[0];
    if (!row) return undefined;
    return {
      browserSessionId: row.browser_session_id,
      displayName: row.display_name,
      isHost: row.is_host === 1,
      ...(row.participant_session_id ? { participantSessionId: row.participant_session_id } : {}),
      ...(row.participant_generation === null ? {} : { participantGeneration: row.participant_generation }),
    };
  }

  addBrowser(input: BrowserRecord, now: number): void {
    this.sql.exec("INSERT INTO browser_sessions (browser_session_id, display_name, is_host, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", input.browserSessionId, input.displayName, input.isHost ? 1 : 0, now, now);
  }

  browserCount(): number {
    return this.sql.exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM browser_sessions").one().count;
  }

  touchBrowser(browserSessionId: string, now: number): void {
    this.sql.exec("UPDATE browser_sessions SET last_seen_at = ? WHERE browser_session_id = ?", now, browserSessionId);
  }

  setSession(sessionId: string): void {
    this.sql.exec("UPDATE meeting SET session_id = ? WHERE singleton = 1", sessionId);
  }

  setParticipant(browserSessionId: string, participantSessionId: string, participantGeneration?: number): void {
    this.sql.exec("UPDATE browser_sessions SET participant_session_id = ?, participant_generation = COALESCE(?, participant_generation) WHERE browser_session_id = ?", participantSessionId, participantGeneration ?? null, browserSessionId);
  }

  deleteBrowser(browserSessionId: string): void {
    this.sql.exec("DELETE FROM browser_sessions WHERE browser_session_id = ?", browserSessionId);
  }

  clearMeeting(): void {
    this.sql.exec("DELETE FROM browser_sessions");
    this.sql.exec("DELETE FROM meeting");
  }
}
