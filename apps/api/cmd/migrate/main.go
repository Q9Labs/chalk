package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

const migrationTimeout = 15 * time.Minute

type options struct {
	databaseURLFile string
	target          int64
}

func main() {
	options, err := parseOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "migration configuration failed: %v\n", err)
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), migrationTimeout)
	defer cancel()
	if err := migrate(ctx, options); err != nil {
		fmt.Fprintf(os.Stderr, "database migration failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("database migrations complete target=%d\n", options.target)
}

func parseOptions(args []string) (options, error) {
	flags := flag.NewFlagSet("chalk-migrate", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	databaseURLFile := flags.String("database-url-file", "", "file containing the dedicated migration database URL")
	targetText := flags.String("target", "", "migration version to apply")
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 {
		return options{}, errors.New("unexpected positional arguments")
	}
	if *databaseURLFile == "" {
		return options{}, errors.New("--database-url-file is required")
	}
	if !filepath.IsAbs(*databaseURLFile) {
		return options{}, errors.New("--database-url-file must be absolute")
	}
	if *targetText == "" {
		return options{}, errors.New("--target is required")
	}
	target, err := strconv.ParseInt(*targetText, 10, 64)
	if err != nil || target < 1 {
		return options{}, errors.New("--target must be a positive migration version")
	}
	if target > migrations.LatestVersion {
		return options{}, fmt.Errorf("migration target %d is newer than this image's migration set", target)
	}
	return options{databaseURLFile: *databaseURLFile, target: target}, nil
}

func migrate(ctx context.Context, options options) error {
	databaseURL, err := readDatabaseURL(options.databaseURLFile)
	if err != nil {
		return err
	}
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return errors.New("open migration database")
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)

	if err := database.PingContext(ctx); err != nil {
		return errors.New("ping migration database")
	}
	provider, err := newMigrationProvider(database, migrations.Files, goose.DialectPostgres)
	if err != nil {
		return errors.New("configure migration provider")
	}
	if _, err := provider.UpTo(ctx, options.target); err != nil {
		return fmt.Errorf("apply migrations through %d: %w", options.target, redactDatabaseURL(err, databaseURL))
	}
	return nil
}

func newMigrationProvider(database *sql.DB, migrationFiles fs.FS, dialect goose.Dialect) (*goose.Provider, error) {
	return goose.NewProvider(
		dialect,
		database,
		migrationFiles,
		goose.WithAllowOutofOrder(true),
		goose.WithLogger(goose.NopLogger()),
	)
}

func readDatabaseURL(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", errors.New("read migration database URL file")
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("migration database URL file is not regular")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("read migration database URL file")
	}
	databaseURL := strings.TrimSpace(string(contents))
	if databaseURL == "" {
		return "", errors.New("migration database URL is empty")
	}
	if !strings.HasPrefix(databaseURL, "postgres://") && !strings.HasPrefix(databaseURL, "postgresql://") {
		return "", errors.New("migration database URL must use PostgreSQL")
	}
	return databaseURL, nil
}

func redactDatabaseURL(err error, databaseURL string) error {
	if err == nil {
		return nil
	}
	return errors.New(strings.ReplaceAll(err.Error(), databaseURL, "[redacted database URL]"))
}
