import type { SqlStorage } from "cloudflare:workers";

export type SpaceOrigin = "isolated" | "legacy";

export type LeaseRecord = {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly creatorCredentialId: string;
  readonly logId: string;
  readonly episodeId?: string;
  readonly spaceId?: string;
  readonly spaceOrigin: SpaceOrigin;
};

export type ParticipantCredentialRecord = {
  readonly participantCredentialId: string;
  readonly displayName: string;
  readonly isCreator: boolean;
  readonly participantGeneration?: number;
  readonly participantId?: string;
};

type LeaseRow = {
  readonly created_at: number;
  readonly expires_at: number;
  readonly creator_credential_id: string;
  readonly log_id: string;
  readonly episode_id: string | null;
  readonly space_id: string | null;
  readonly space_origin: string | null;
};

type TableInfoRow = {
  readonly name: string;
};

type ParticipantCredentialRow = {
  readonly participant_credential_id: string;
  readonly display_name: string;
  readonly is_creator: number;
  readonly participant_generation: number | null;
  readonly participant_id: string | null;
};

export class LeaseStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS episode_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      log_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      episode_id TEXT,
      creator_credential_id TEXT NOT NULL,
      space_id TEXT,
      space_origin TEXT NOT NULL DEFAULT 'legacy' CHECK (space_origin IN ('isolated', 'legacy'))
    )`);
    this.migrateEpisodeLeaseSchema();
    sql.exec(`CREATE TABLE IF NOT EXISTS participant_credentials (
      participant_credential_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      is_creator INTEGER NOT NULL CHECK (is_creator IN (0, 1)),
      participant_id TEXT,
      participant_generation INTEGER,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )`);
  }

  lease(): LeaseRecord | undefined {
    const row = this.sql.exec<LeaseRow>("SELECT log_id, created_at, expires_at, episode_id, creator_credential_id, space_id, space_origin FROM episode_lease WHERE singleton = 1").toArray()[0];
    if (!row) return undefined;
    return {
      logId: row.log_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      creatorCredentialId: row.creator_credential_id,
      spaceOrigin: row.space_origin === "isolated" ? "isolated" : "legacy",
      ...(row.episode_id ? { episodeId: row.episode_id } : {}),
      ...(row.space_id === null ? {} : { spaceId: row.space_id }),
    };
  }

  createLease(input: LeaseRecord): void {
    this.sql.exec("INSERT INTO episode_lease (singleton, log_id, created_at, expires_at, creator_credential_id, space_id, space_origin) VALUES (1, ?, ?, ?, ?, ?, ?)", input.logId, input.createdAt, input.expiresAt, input.creatorCredentialId, input.spaceId ?? null, input.spaceOrigin);
  }

  credential(participantCredentialId: string): ParticipantCredentialRecord | undefined {
    const row = this.sql.exec<ParticipantCredentialRow>("SELECT participant_credential_id, display_name, is_creator, participant_id, participant_generation FROM participant_credentials WHERE participant_credential_id = ?", participantCredentialId).toArray()[0];
    if (!row) return undefined;
    return {
      participantCredentialId: row.participant_credential_id,
      displayName: row.display_name,
      isCreator: row.is_creator === 1,
      ...(row.participant_id ? { participantId: row.participant_id } : {}),
      ...(row.participant_generation === null ? {} : { participantGeneration: row.participant_generation }),
    };
  }

  addCredential(input: ParticipantCredentialRecord, now: number): void {
    this.sql.exec("INSERT INTO participant_credentials (participant_credential_id, display_name, is_creator, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", input.participantCredentialId, input.displayName, input.isCreator ? 1 : 0, now, now);
  }

  credentialCount(): number {
    return this.sql.exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM participant_credentials").one().count;
  }

  touchCredential(participantCredentialId: string, now: number): void {
    this.sql.exec("UPDATE participant_credentials SET last_seen_at = ? WHERE participant_credential_id = ?", now, participantCredentialId);
  }

  setEpisode(episodeId: string): void {
    this.sql.exec("UPDATE episode_lease SET episode_id = ? WHERE singleton = 1", episodeId);
  }

  setSpace(spaceId: string): void {
    this.sql.exec("UPDATE episode_lease SET space_id = ? WHERE singleton = 1", spaceId);
  }

  setParticipant(participantCredentialId: string, participantId: string, participantGeneration?: number): void {
    this.sql.exec("UPDATE participant_credentials SET participant_id = ?, participant_generation = COALESCE(?, participant_generation) WHERE participant_credential_id = ?", participantId, participantGeneration ?? null, participantCredentialId);
  }

  deleteCredential(participantCredentialId: string): void {
    this.sql.exec("DELETE FROM participant_credentials WHERE participant_credential_id = ?", participantCredentialId);
  }

  clearLease(): void {
    this.sql.exec("DELETE FROM participant_credentials");
    this.sql.exec("DELETE FROM episode_lease");
  }

  private migrateEpisodeLeaseSchema(): void {
    const columns = new Set(
      this.sql
        .exec<TableInfoRow>("PRAGMA table_info(episode_lease)")
        .toArray()
        .map(({ name }) => name),
    );
    if (!columns.has("space_id")) this.sql.exec("ALTER TABLE episode_lease ADD COLUMN space_id TEXT");
    if (!columns.has("space_origin")) this.sql.exec("ALTER TABLE episode_lease ADD COLUMN space_origin TEXT NOT NULL DEFAULT 'legacy' CHECK (space_origin IN ('isolated', 'legacy'))");
  }
}
