package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 5 {
		return fmt.Errorf("expected tenant, space, account and request key")
	}
	tenant, err := utilities.ParseID(os.Args[1])
	if err != nil {
		return err
	}
	space, err := utilities.ParseID(os.Args[2])
	if err != nil {
		return err
	}
	account, err := utilities.ParseID(os.Args[3])
	if err != nil {
		return err
	}
	ctx := context.Background()
	databaseURL := os.Getenv("CHALK_SYNC_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = os.Getenv("CHALK_DATABASE_URL")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	joined, err := postgres.NewEpisodeLifecycleRepository(pool).JoinPublic(ctx, episodes.PublicJoinInput{
		TenantID: tenant, SpaceID: space, AccountID: account,
		IdentityMode: "account", DisplayName: "Returning account", Role: "collaborator",
		Request: episodes.Request{Key: os.Args[4]},
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"participant_id": joined.Participant.ID.String(), "generation": joined.Participant.Generation,
		"intent_id": joined.Intent.ID.String(), "role": joined.Participant.Role,
		"capabilities": joined.Participant.Capabilities,
	})
}
