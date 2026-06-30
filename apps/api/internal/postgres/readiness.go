package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Readiness struct {
	Pool *pgxpool.Pool
}

func (r Readiness) Check(ctx context.Context) error {
	if r.Pool == nil {
		return fmt.Errorf("postgres pool is not configured")
	}

	if err := r.Pool.Ping(ctx); err != nil {
		return fmt.Errorf("ping postgres: %w", err)
	}

	return nil
}
