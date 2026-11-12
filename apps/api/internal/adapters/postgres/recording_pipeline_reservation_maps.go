package postgres

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func mapReservation(row sqlc.CreateRecordingReservationRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:                    utilities.IDFromBytes(row.ID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:               utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID:             utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:           utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:        row.IdempotencyKey,
		PolicySnapshotVersion: row.PolicySnapshotVersion,
		ParticipantCount:      int(row.ParticipantCount),
		MaxDuration:           time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:       row.InputBitrateBps,
		State:                 recordingpipeline.ReservationState(row.State),
		StartsAt:              nullableTimestamp(row.StartsAt),
		EndsAt:                timestamp(row.EndsAt),
		UpdatedAt:             timestamp(row.UpdatedAt),
		CreatedAt:             timestamp(row.CreatedAt),
	}
}

func mapReleasedReservation(row sqlc.ReleaseRecordingReservationRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:                    utilities.IDFromBytes(row.ID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:               utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID:             utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:           utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:        row.IdempotencyKey,
		PolicySnapshotVersion: row.PolicySnapshotVersion,
		ParticipantCount:      int(row.ParticipantCount),
		MaxDuration:           time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:       row.InputBitrateBps,
		State:                 recordingpipeline.ReservationState(row.State),
		StartsAt:              nullableTimestamp(row.StartsAt),
		EndsAt:                timestamp(row.EndsAt),
		UpdatedAt:             timestamp(row.UpdatedAt),
		CreatedAt:             timestamp(row.CreatedAt),
	}
}

func mapExpiredReservation(row sqlc.ExpireRecordingReservationsRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:                    utilities.IDFromBytes(row.ID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:               utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID:             utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:           utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:        row.IdempotencyKey,
		PolicySnapshotVersion: row.PolicySnapshotVersion,
		ParticipantCount:      int(row.ParticipantCount),
		MaxDuration:           time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:       row.InputBitrateBps,
		State:                 recordingpipeline.ReservationState(row.State),
		StartsAt:              nullableTimestamp(row.StartsAt),
		EndsAt:                timestamp(row.EndsAt),
		UpdatedAt:             timestamp(row.UpdatedAt),
		CreatedAt:             timestamp(row.CreatedAt),
	}
}

func mapGetReservation(row sqlc.GetRecordingReservationRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:                    utilities.IDFromBytes(row.ID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:               utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID:             utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:           utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:        row.IdempotencyKey,
		PolicySnapshotVersion: row.PolicySnapshotVersion,
		ParticipantCount:      int(row.ParticipantCount),
		MaxDuration:           time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:       row.InputBitrateBps,
		State:                 recordingpipeline.ReservationState(row.State),
		StartsAt:              nullableTimestamp(row.StartsAt),
		EndsAt:                timestamp(row.EndsAt),
		UpdatedAt:             timestamp(row.UpdatedAt),
		CreatedAt:             timestamp(row.CreatedAt),
	}
}

func mapReservationByKey(row sqlc.GetRecordingReservationByKeyRow) recordingpipeline.Reservation {
	return recordingpipeline.Reservation{
		ID:                    utilities.IDFromBytes(row.ID.Bytes),
		TenantID:              utilities.IDFromBytes(row.TenantID.Bytes),
		SpaceID:               utilities.IDFromBytes(row.SpaceID.Bytes),
		EpisodeID:             utilities.IDFromBytes(row.EpisodeID.Bytes),
		RecordingID:           utilities.IDFromBytes(row.RecordingID.Bytes),
		IdempotencyKey:        row.IdempotencyKey,
		PolicySnapshotVersion: row.PolicySnapshotVersion,
		ParticipantCount:      int(row.ParticipantCount),
		MaxDuration:           time.Duration(row.MaxDurationSeconds) * time.Second,
		InputBitrateBPS:       row.InputBitrateBps,
		State:                 recordingpipeline.ReservationState(row.State),
		StartsAt:              nullableTimestamp(row.StartsAt),
		EndsAt:                timestamp(row.EndsAt),
		UpdatedAt:             timestamp(row.UpdatedAt),
		CreatedAt:             timestamp(row.CreatedAt),
	}
}

func mapPoolHealth(row sqlc.GetRecordingPoolHealthRow) recordingpipeline.PoolHealth {
	return recordingpipeline.PoolHealth{
		Role:          recordingpipeline.PoolRole(row.Role),
		AdmissionOpen: row.AdmissionOpen,
		ReadyCapacity: int(row.ReadyCapacity),
		Reason:        row.Reason,
		ObservedAt:    timestamp(row.ObservedAt),
		UpdatedAt:     timestamp(row.UpdatedAt),
	}
}
