import type { SqlStorage } from "cloudflare:workers";

export type MeetingRecord = {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly hostClientSessionId: string;
  readonly logId: string;
  readonly sessionId?: string;
};

export type ClientRecord = {
  readonly clientSessionId: string;
  readonly displayName: string;
  readonly isHost: boolean;
  readonly participantGeneration?: number;
  readonly participantSessionId?: string;
};

type MeetingRow = {
  readonly created_at: number;
  readonly expires_at: number;
  readonly host_client_session_id: string;
  readonly log_id: string;
  readonly session_id: string | null;
};

type ClientRow = {
  readonly client_session_id: string;
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
      host_client_session_id TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS client_sessions (
      client_session_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      is_host INTEGER NOT NULL CHECK (is_host IN (0, 1)),
      participant_session_id TEXT,
      participant_generation INTEGER,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )`);
  }

  meeting(): MeetingRecord | undefined {
    const row = this.sql.exec<MeetingRow>("SELECT log_id, created_at, expires_at, session_id, host_client_session_id FROM meeting WHERE singleton = 1").toArray()[0];
    if (!row) return undefined;
    return {
      logId: row.log_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      hostClientSessionId: row.host_client_session_id,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
    };
  }

  createMeeting(input: MeetingRecord): void {
    this.sql.exec("INSERT INTO meeting (singleton, log_id, created_at, expires_at, host_client_session_id) VALUES (1, ?, ?, ?, ?)", input.logId, input.createdAt, input.expiresAt, input.hostClientSessionId);
  }

  client(clientSessionId: string): ClientRecord | undefined {
    const row = this.sql.exec<ClientRow>("SELECT client_session_id, display_name, is_host, participant_session_id, participant_generation FROM client_sessions WHERE client_session_id = ?", clientSessionId).toArray()[0];
    if (!row) return undefined;
    return {
      clientSessionId: row.client_session_id,
      displayName: row.display_name,
      isHost: row.is_host === 1,
      ...(row.participant_session_id ? { participantSessionId: row.participant_session_id } : {}),
      ...(row.participant_generation === null ? {} : { participantGeneration: row.participant_generation }),
    };
  }

  addClient(input: ClientRecord, now: number): void {
    this.sql.exec("INSERT INTO client_sessions (client_session_id, display_name, is_host, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", input.clientSessionId, input.displayName, input.isHost ? 1 : 0, now, now);
  }

  clientCount(): number {
    return this.sql.exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM client_sessions").one().count;
  }

  touchClient(clientSessionId: string, now: number): void {
    this.sql.exec("UPDATE client_sessions SET last_seen_at = ? WHERE client_session_id = ?", now, clientSessionId);
  }

  setSession(sessionId: string): void {
    this.sql.exec("UPDATE meeting SET session_id = ? WHERE singleton = 1", sessionId);
  }

  setParticipant(clientSessionId: string, participantSessionId: string, participantGeneration?: number): void {
    this.sql.exec("UPDATE client_sessions SET participant_session_id = ?, participant_generation = COALESCE(?, participant_generation) WHERE client_session_id = ?", participantSessionId, participantGeneration ?? null, clientSessionId);
  }

  deleteClient(clientSessionId: string): void {
    this.sql.exec("DELETE FROM client_sessions WHERE client_session_id = ?", clientSessionId);
  }

  clearMeeting(): void {
    this.sql.exec("DELETE FROM client_sessions");
    this.sql.exec("DELETE FROM meeting");
  }
}
