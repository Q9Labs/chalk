package jobs

import (
	"context"
	"log"
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
}

func NewRoomCleanup(queries *db.Queries, roomSvc RoomEnder) *RoomCleanup {
	return &RoomCleanup{db: queries, roomSvc: roomSvc}
}

func (c *RoomCleanup) CleanupEmptyRooms(ctx context.Context, timeoutMinutes int32) error {
	rooms, err := c.db.ListEmptyActiveRooms(ctx, timeoutMinutes)
	if err != nil {
		return err
	}

	for _, r := range rooms {
		log.Printf("Auto-ending empty room: %s (created %v ago)", r.ID, time.Since(r.CreatedAt))
		if err := c.roomSvc.EndRoom(ctx, r.ID); err != nil {
			log.Printf("Failed to end room %s: %v", r.ID, err)
		}
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
				log.Printf("Room cleanup error: %v", err)
			}
		case <-ctx.Done():
			log.Println("Room cleanup stopped")
			return
		}
	}
}
