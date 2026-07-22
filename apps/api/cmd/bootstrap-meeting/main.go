package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type commandOptions struct {
	ConfirmNonLocal bool
	OwnerUserID     string
	TenantName      string
	RoomName        string
	RoomSlug        string
	APIKeyName      string
	APIKeyTTL       time.Duration
	ResultFile      string
}

type environmentReader func(string) string
type databaseOpener func(context.Context, string) (bootstrapDatabase, error)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := execute(ctx, os.Args[1:], os.Getenv, os.Stdout, openBootstrapDatabase, time.Now); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "bootstrap meeting: %v\n", err)
		os.Exit(1)
	}
}

func execute(ctx context.Context, arguments []string, environment environmentReader, output io.Writer, open databaseOpener, now func() time.Time) error {
	options, err := parseOptions(arguments)
	if err != nil {
		return err
	}
	environmentName := strings.TrimSpace(environment("CHALK_API_ENV"))
	if environmentName == "" {
		return errors.New("CHALK_API_ENV is required")
	}
	if environmentName != "local" && !options.ConfirmNonLocal {
		return fmt.Errorf("--confirm-non-local is required when CHALK_API_ENV=%s", environmentName)
	}
	databaseURL := strings.TrimSpace(environment("CHALK_DATABASE_URL"))
	if databaseURL == "" {
		return errors.New("CHALK_DATABASE_URL is required")
	}
	if err := validateBootstrapDatabaseURL(environmentName, databaseURL); err != nil {
		return err
	}
	if err := prepareIdentityOptions(&options); err != nil {
		return err
	}
	resultFile := strings.TrimSpace(options.ResultFile)
	if resultFile == "" {
		return errors.New("--result-file is required")
	}
	ownerUserID, err := utilities.ParseID(options.OwnerUserID)
	if err != nil {
		return errors.New("--owner-user-id must be a valid UUID")
	}
	if options.APIKeyTTL <= 0 || options.APIKeyTTL > apikeys.MaxTTL {
		return fmt.Errorf("--api-key-ttl must be greater than zero and no more than %s", apikeys.MaxTTL)
	}

	database, err := open(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	transaction, err := database.BeginBootstrap(ctx)
	if err != nil {
		return err
	}
	defer transaction.Rollback(ctx)

	result, err := bootstrapMeeting(ctx, transaction, bootstrapInput{
		TenantName: options.TenantName, RoomName: options.RoomName, RoomSlug: options.RoomSlug,
		APIKeyName: options.APIKeyName, APIKeyTTL: options.APIKeyTTL, OwnerUserID: ownerUserID, Now: now().UTC(),
	})
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return errors.New("encode bootstrap result failed")
	}
	encoded = append(encoded, '\n')
	if err := writeResultFile(resultFile, encoded); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(resultFile)
		}
	}()
	if err := transaction.Commit(ctx); err != nil {
		return err
	}
	committed = true
	if _, err := output.Write(encoded); err != nil {
		return errors.New("write bootstrap result failed")
	}
	return nil
}

func parseOptions(arguments []string) (commandOptions, error) {
	options := commandOptions{}
	flags := flag.NewFlagSet("bootstrap-meeting", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&options.ConfirmNonLocal, "confirm-non-local", false, "confirm a non-local database mutation")
	flags.StringVar(&options.OwnerUserID, "owner-user-id", "", "existing user UUID that will own the tenant")
	flags.StringVar(&options.TenantName, "tenant-name", defaultTenantName, "bootstrap tenant name")
	flags.StringVar(&options.RoomName, "room-name", defaultRoomName, "bootstrap room name")
	flags.StringVar(&options.RoomSlug, "room-slug", defaultRoomSlug, "bootstrap room slug")
	flags.StringVar(&options.APIKeyName, "api-key-name", defaultAPIKeyName, "broker API key name")
	flags.DurationVar(&options.APIKeyTTL, "api-key-ttl", defaultAPIKeyTTL, "broker API key lifetime")
	flags.StringVar(&options.ResultFile, "result-file", "", "new mode-0600 file that preserves the machine-readable result")
	if err := flags.Parse(arguments); err != nil {
		return commandOptions{}, fmt.Errorf("invalid arguments: %w", err)
	}
	if flags.NArg() != 0 {
		return commandOptions{}, errors.New("positional arguments are not supported")
	}
	return options, nil
}

func validateBootstrapDatabaseURL(environmentName, databaseURL string) error {
	if environmentName == "local" {
		return nil
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return errors.New("CHALK_DATABASE_URL must be a valid URL")
	}
	switch strings.ToLower(parsed.Query().Get("sslmode")) {
	case "require", "verify-ca", "verify-full":
		return nil
	default:
		return errors.New("CHALK_DATABASE_URL must set sslmode=require, verify-ca, or verify-full outside local environments")
	}
}

func prepareIdentityOptions(options *commandOptions) error {
	values := []struct {
		name  string
		value *string
	}{
		{name: "--tenant-name", value: &options.TenantName},
		{name: "--room-name", value: &options.RoomName},
		{name: "--room-slug", value: &options.RoomSlug},
		{name: "--api-key-name", value: &options.APIKeyName},
	}
	for _, item := range values {
		*item.value = strings.TrimSpace(*item.value)
		if *item.value == "" {
			return fmt.Errorf("%s must not be empty", item.name)
		}
	}
	return nil
}

func writeResultFile(path string, encoded []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return errors.New("create result file failed")
	}
	remove := true
	defer func() {
		_ = file.Close()
		if remove {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(encoded); err != nil {
		return errors.New("write result file failed")
	}
	if err := file.Sync(); err != nil {
		return errors.New("sync result file failed")
	}
	if err := file.Close(); err != nil {
		return errors.New("close result file failed")
	}
	remove = false
	return nil
}
