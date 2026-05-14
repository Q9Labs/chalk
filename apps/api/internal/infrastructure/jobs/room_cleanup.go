package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

type RoomEnder interface {
	EndRoom(ctx context.Context, roomID uuid.UUID) error
}

type RoomCleanup struct {
	db      *db.Queries
	roomSvc RoomEnder
	logger  *slog.Logger
}

func NewRoomCleanup(queries *db.Queries, roomSvc RoomEnder, logger *slog.Logger) *RoomCleanup {
	if logger == nil {
		logger = slog.Default()
	}
	return &RoomCleanup{
		db:      queries,
		roomSvc: roomSvc,
		logger:  logger.With("component", "room_cleanup"),
	}
}

func (c *RoomCleanup) CleanupEmptyRooms(ctx context.Context, timeoutMinutes int32) error {
	start := time.Now()

	rooms, err := c.db.ListEmptyActiveRooms(ctx, timeoutMinutes)
	if err != nil {
		return err
	}

	var ended, failed int
	for _, r := range rooms {
		roomStart := time.Now()
		if err := c.roomSvc.EndRoom(ctx, r.ID); err != nil {
			c.logger.Error("room cleanup failed",
				"operation", "end_empty_room",
				"room_id", r.ID,
				"created_at", r.CreatedAt,
				"duration_ms", time.Since(roomStart).Milliseconds(),
				"error", err.Error(),
			)
			failed++
			continue
		}
		ended++
	}

	if len(rooms) > 0 {
		c.logger.Info("room cleanup completed",
			"operation", "cleanup_batch",
			"rooms_found", len(rooms),
			"rooms_ended", ended,
			"rooms_failed", failed,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	}

	return nil
}

func (c *RoomCleanup) Run(ctx context.Context, interval time.Duration, timeoutMinutes int32) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := c.CleanupEmptyRooms(ctx, timeoutMinutes); err != nil {
				c.logger.Error("room cleanup error",
					"operation", "cleanup_tick",
					"error", err.Error(),
				)
			}
		case <-ctx.Done():
			c.logger.Info("room cleanup stopped")
			return
		}
	}
}
