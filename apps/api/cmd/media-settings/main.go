// media-settings is the operator's way to choose the media plane for a Tenant or a
// Space. The public API cannot select the own SFU, and no operator principal exists in
// production, so this command is the only write path to it. It logs one JSON line per
// change to stdout and keeps Tenant and Space IDs out of metrics.
//
//	media-settings get --tenant ID [--space ID]
//	media-settings set --tenant ID [--space ID] --plane cf_sfu|chalk_sfu|inherit
//	media-settings backfill [--dry-run]
//	media-settings new-episodes [--state on|off --operator NAME --reason TEXT]
//
// new-episodes is the kill switch of the own SFU, stored in the database so a flip needs
// no API restart. off sends every new Episode to Cloudflare; Episodes already on the own
// SFU keep running there. With --state it flips the switch and writes an audit row (who,
// why, before, after) in the same transaction; without it, it reads the switch.
//
// Run it with the same settings the API runs with: it reads CHALK_DATABASE_URL,
// CHALK_DEFAULT_MEDIA_PLANE, CHALK_SFU_ALLOWED_SPACES and CHALK_SFU_NEW_EPISODES.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "media-settings:", err)
		os.Exit(1)
	}
}

const usage = "usage: media-settings get|set|backfill|new-episodes ... (see the file comment)"

func run(ctx context.Context, args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	command, args := args[0], args[1:]
	flags := flag.NewFlagSet("media-settings "+command, flag.ContinueOnError)
	tenantFlag := flags.String("tenant", "", "Tenant ID")
	spaceFlag := flags.String("space", "", "Space ID; omit to act on the Tenant")
	planeFlag := flags.String("plane", "", "cf_sfu, chalk_sfu, or inherit to clear (set only)")
	dryRun := flags.Bool("dry-run", false, "list the changes without writing them (backfill only)")
	stateFlag := flags.String("state", "", "on or off (new-episodes only); omit to read")
	operatorFlag := flags.String("operator", "", "who flips the switch (new-episodes --state only)")
	reasonFlag := flags.String("reason", "", "why (new-episodes --state only)")
	limit := flags.Duration("timeout", time.Minute, "whole-command deadline, at most 10 minutes")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *limit <= 0 || *limit > 10*time.Minute {
		return errors.New("--timeout must be in (0, 10m] and no positional arguments are allowed")
	}
	parsed, err := buildRequest(command, *tenantFlag, *spaceFlag, *planeFlag, *dryRun, *stateFlag, *operatorFlag, *reasonFlag)
	if err != nil {
		return err
	}
	url, policy, err := loadDatabaseSettings(parsed)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, *limit)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return errors.New("open database")
	}
	defer pool.Close()
	return newSettings(pool, policy, out).execute(ctx, parsed)
}

func buildRequest(command, tenant, space, plane string, dryRun bool, state, operator, reason string) (request, error) {
	switch {
	case command == "new-episodes":
		return parseSwitchRequest(tenant, space, plane, dryRun, state, operator, reason)
	case state != "" || operator != "" || reason != "":
		return request{}, errors.New("--state, --operator and --reason apply to new-episodes only")
	default:
		return parseRequest(command, tenant, space, plane, dryRun)
	}
}

// loadDatabaseSettings reads the database URL and the media plane policy from the environment.
func loadDatabaseSettings(parsed request) (string, spaces.PlanePolicy, error) {
	url := os.Getenv(config.DatabaseURL)
	if url == "" {
		return "", spaces.PlanePolicy{}, fmt.Errorf("%s required", config.DatabaseURL)
	}
	policy, err := config.LoadPlanePolicy()
	if err != nil {
		return "", spaces.PlanePolicy{}, err
	}
	if parsed.command == "backfill" {
		if _, set := os.LookupEnv(config.ChalkSFUAllowedSpaces); !set {
			return "", spaces.PlanePolicy{}, fmt.Errorf("state the allowlist the API runs with: set %s (empty means none)", config.ChalkSFUAllowedSpaces)
		}
	}
	return url, policy, nil
}

type request struct {
	command string
	tenant  utilities.ID
	space   utilities.ID
	plane   *spaces.MediaPlaneProvider
	dryRun  bool
	// flip is set for new-episodes --state: paused is the value to write.
	flip     bool
	paused   bool
	operator string
	reason   string
}

func parseSwitchRequest(tenant, space, plane string, dryRun bool, state, operator, reason string) (request, error) {
	if tenant != "" || space != "" || plane != "" || dryRun {
		return request{}, errors.New("new-episodes takes only --state, --operator and --reason")
	}
	r := request{command: "new-episodes"}
	switch state {
	case "":
		if operator != "" || reason != "" {
			return request{}, errors.New("--operator and --reason apply to --state")
		}
		return r, nil
	case "on":
	case "off":
		r.paused = true
	default:
		return request{}, errors.New("--state must be on or off")
	}
	if strings.TrimSpace(operator) == "" || strings.TrimSpace(reason) == "" {
		return request{}, errors.New("flipping the switch needs --operator and --reason")
	}
	r.flip, r.operator, r.reason = true, strings.TrimSpace(operator), strings.TrimSpace(reason)
	return r, nil
}

func parseRequest(command, tenantText, spaceText, planeText string, dryRun bool) (request, error) {
	r := request{command: command, dryRun: dryRun}
	switch command {
	case "get", "set", "backfill":
	default:
		return request{}, errors.New(usage)
	}
	if command == "backfill" {
		if tenantText != "" || spaceText != "" || planeText != "" {
			return request{}, errors.New("backfill takes no --tenant, --space or --plane")
		}
		return r, nil
	}
	if dryRun {
		return request{}, errors.New("--dry-run applies to backfill only")
	}
	var err error
	if r.tenant, err = utilities.ParseID(tenantText); err != nil {
		return request{}, errors.New("--tenant must be a Tenant ID")
	}
	if spaceText != "" {
		if r.space, err = utilities.ParseID(spaceText); err != nil {
			return request{}, errors.New("--space must be a Space ID")
		}
	}
	if command == "get" {
		if planeText != "" {
			return request{}, errors.New("--plane applies to set only")
		}
		return r, nil
	}
	switch planeText {
	case "inherit":
	case "":
		return request{}, errors.New("set needs --plane cf_sfu, chalk_sfu or inherit")
	default:
		plane, err := spaces.ParseMediaPlaneProvider(planeText)
		if err != nil {
			return request{}, errors.New("--plane must be cf_sfu, chalk_sfu or inherit")
		}
		r.plane = &plane
	}
	return r, nil
}
