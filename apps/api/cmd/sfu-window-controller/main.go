// The window controller is separate from the API: the API only reads routing
// and never needs permission to create or delete a DigitalOcean Droplet.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/sfufleet"
)

const controllerLease = 0x4348414c4b534655

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("SFU window controller stopped", "reason", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	provider, control, policy, err := loadRuntime()
	if err != nil {
		return err
	}
	db, err := pgx.ParseConfig(os.Getenv("CHALK_SFU_WINDOW_DATABASE_URL"))
	if err != nil || os.Getenv("CHALK_SFU_WINDOW_DATABASE_URL") == "" {
		return errors.New("set CHALK_SFU_WINDOW_DATABASE_URL to a direct database connection")
	}
	db.ConnectTimeout = 5 * time.Second
	db.RuntimeParams["application_name"] = "chalk-sfu-window-controller"
	db.RuntimeParams["synchronous_commit"] = "on"
	db.RuntimeParams["statement_timeout"] = "5s"
	db.RuntimeParams["lock_timeout"] = "2s"
	conn, err := pgx.ConnectConfig(ctx, db)
	if err != nil {
		return errors.New("connect to the SFU window database")
	}
	defer conn.Close(context.Background())
	var acquired bool
	if err := conn.QueryRow(ctx, "select pg_try_advisory_lock($1::bigint)", controllerLease).Scan(&acquired); err != nil || !acquired {
		return errors.New("acquire the SFU window controller lease")
	}

	reconciler, err := sfufleet.NewReconciler(policy, postgres.NewSFUWindowStore(conn), provider, control)
	if err != nil {
		return err
	}
	tick := time.NewTicker(sfufleet.ReconcileEvery)
	defer tick.Stop()
	for {
		pass, cancel := context.WithTimeout(ctx, time.Minute)
		result, err := reconciler.Reconcile(pass)
		cancel()
		slog.Info("SFU window plan", "booked_slots", result.PeakBookedSlots,
			"required_nodes", result.RequiredNodes, "target_nodes", result.TargetNodes,
			"serving", result.Serving, "online", result.Online, "starting", result.Starting,
			"draining", result.Draining, "deleting", result.Deleting, "budget_limited", result.BudgetLimited)
		if err != nil && ctx.Err() == nil {
			slog.Warn("SFU window reconcile incomplete", "reason", err)
		}
		if conn.IsClosed() && ctx.Err() == nil {
			return errors.New("SFU window database connection and controller lease lost")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}

func loadRuntime() (windowProvider, chalksfu.WindowControl, sfufleet.Policy, error) {
	var provider windowProvider
	var control chalksfu.WindowControl
	var policy sfufleet.Policy
	env := os.Getenv("CHALK_SFU_WINDOW_ENVIRONMENT")
	if env != "nightly" && env != "production" {
		return provider, control, policy, errors.New("CHALK_SFU_WINDOW_ENVIRONMENT must be nightly or production")
	}
	mode := os.Getenv("CHALK_SFU_WINDOW_MODE")
	if mode != "scale" && mode != "retire" {
		return provider, control, policy, errors.New("CHALK_SFU_WINDOW_MODE must be scale or retire")
	}
	policy.Application = os.Getenv(config.ChalkSFUApplicationID)
	policy.Retire = mode == "retire"

	snapshot, err := readNumber("CHALK_SFU_WINDOW_SNAPSHOT_ID", 0)
	if err != nil {
		return provider, control, policy, err
	}
	slots, err := readNumber("CHALK_SFU_WINDOW_STANDING_SLOTS", 0)
	if err != nil || slots < 1 || slots > 10 {
		return provider, control, policy, errors.New("set CHALK_SFU_WINDOW_STANDING_SLOTS to measured standing capacity (1 to 10 class slots)")
	}
	policy.Capacity = sfufleet.Capacity{StandingSlots: int(slots), SlotsPerNode: 4, SpareSlots: 4, MaxNodes: 6}
	hours, err := readNumber("CHALK_SFU_WINDOW_BUDGET_NODE_HOURS", 900)
	if err != nil || hours < 1 || hours > 930 {
		return provider, control, policy, errors.New("CHALK_SFU_WINDOW_BUDGET_NODE_HOURS must be 1 to 930")
	}
	policy.MonthlyNodeTime = time.Duration(hours) * time.Hour

	do, err := digitalocean.NewSFUWindow(digitalocean.SFUWindowConfig{
		Token:       os.Getenv("CHALK_SFU_WINDOW_PROVIDER_TOKEN"),
		OwnerTag:    "chalk-sfu-window-" + env,
		FirewallTag: "chalk-sfu-window-" + env + "-firewall",
		FirewallID:  os.Getenv("CHALK_SFU_WINDOW_FIREWALL_ID"),
		SnapshotID:  snapshot,
		Region:      os.Getenv("CHALK_SFU_WINDOW_REGION"),
		VPCUUID:     os.Getenv("CHALK_SFU_WINDOW_VPC_UUID"),
	})
	if err != nil {
		return provider, control, policy, fmt.Errorf("configure SFU window provider: %w", err)
	}
	control, err = chalksfu.NewWindowControl(config.ChalkSFUConfig{
		ApplicationID:  policy.Application,
		ServerName:     os.Getenv(config.ChalkSFUServerName),
		CAFile:         os.Getenv(config.ChalkSFUCAFile),
		ClientCertFile: os.Getenv(config.ChalkSFUClientCertFile),
		ClientKeyFile:  os.Getenv(config.ChalkSFUClientKeyFile),
		RequestTimeout: 4 * time.Second,
	}, os.Getenv("CHALK_SFU_WINDOW_REVISION"))
	return windowProvider{do}, control, policy, err
}

type windowProvider struct{ *digitalocean.SFUWindow }

func (p windowProvider) Observe(ctx context.Context, id string) (sfufleet.Droplet, bool, error) {
	droplet, found, err := p.SFUWindow.Observe(ctx, id)
	return sfufleet.Droplet(droplet), found, err
}

func (p windowProvider) Create(ctx context.Context, id string) (bool, error) {
	err := p.SFUWindow.Create(ctx, id)
	return err == nil || errors.Is(err, digitalocean.ErrSFUWindowCreateUnknown) ||
		errors.Is(err, digitalocean.ErrSFUWindowExists), err
}

func readNumber(name string, fallback int64) (int64, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return number, nil
}
