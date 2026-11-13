package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/q9labs/chalk/apps/api/db/migrations"
)

type options struct {
	databaseURLFile             string
	target                      int64
	down                        bool
	allowMissing                []int64
	entryWriterProtocol         int
	rollbackEntryWriterProtocol int
	enforceEntryOwnership       string
}

func parseOptions(args []string) (options, error) {
	flags := flag.NewFlagSet("chalk-migrate", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var raw rawOptions
	flags.StringVar(&raw.databaseURLFile, "database-url-file", "", "file containing the dedicated migration database URL")
	flags.IntVar(&raw.entryWriterProtocol, "entry-writer-protocol", 0, "target Sync entry writer protocol (0 or 1)")
	flags.IntVar(&raw.rollbackEntryWriterProtocol, "rollback-entry-writer-protocol", 0, "retained rollback Sync entry writer protocol")
	flags.StringVar(&raw.enforceEntryOwnership, "enforce-entry-ownership", "", "record entry enforcement for this release; requires an expanded rollback baseline")
	flags.StringVar(&raw.targetText, "target", "", "migration version to apply")
	flags.StringVar(&raw.downToText, "down-to", "", "emergency rollback: revert migrations newer than this version, which stays applied")
	allowMissingSet := map[int64]struct{}{}
	flags.Func("allow-missing-version", "allow one explicitly named out-of-order migration; may be repeated", func(value string) error {
		version, err := parseMigrationVersion(value)
		if err != nil {
			return err
		}
		if _, exists := allowMissingSet[version]; exists {
			return fmt.Errorf("--allow-missing-version %d was provided more than once", version)
		}
		allowMissingSet[version] = struct{}{}
		raw.allowMissing = append(raw.allowMissing, version)
		return nil
	})
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 {
		return options{}, errors.New("unexpected positional arguments")
	}
	return raw.validate()
}

// rawOptions holds the flag values before validation.
type rawOptions struct {
	databaseURLFile             string
	targetText                  string
	downToText                  string
	allowMissing                []int64
	entryWriterProtocol         int
	rollbackEntryWriterProtocol int
	enforceEntryOwnership       string
}

func (raw rawOptions) validate() (options, error) {
	if raw.databaseURLFile == "" {
		return options{}, errors.New("--database-url-file is required")
	}
	if !filepath.IsAbs(raw.databaseURLFile) {
		return options{}, errors.New("--database-url-file must be absolute")
	}
	target, down, err := raw.parseTarget()
	if err != nil {
		return options{}, err
	}
	if down && (len(raw.allowMissing) > 0 || raw.entryWriterProtocol != 0 || raw.rollbackEntryWriterProtocol != 0 || raw.enforceEntryOwnership != "") {
		return options{}, errors.New("--down-to takes no out-of-order or Sync entry flags")
	}
	if target > migrations.LatestVersion {
		return options{}, fmt.Errorf("migration target %d is newer than this image's migration set", target)
	}
	if err := raw.validateEntryWriters(); err != nil {
		return options{}, err
	}
	return options{entryWriterProtocol: raw.entryWriterProtocol, rollbackEntryWriterProtocol: raw.rollbackEntryWriterProtocol,
		enforceEntryOwnership: raw.enforceEntryOwnership, databaseURLFile: raw.databaseURLFile, target: target, down: down, allowMissing: raw.allowMissing}, nil
}

// parseTarget reads whichever of --target and --down-to was given.
func (raw rawOptions) parseTarget() (target int64, down bool, err error) {
	if (raw.targetText == "") == (raw.downToText == "") {
		return 0, false, errors.New("exactly one of --target and --down-to is required")
	}
	down = raw.downToText != ""
	flagName, value := "--target", raw.targetText
	if down {
		flagName, value = "--down-to", raw.downToText
	}
	target, err = strconv.ParseInt(value, 10, 64)
	if err != nil || target < 1 {
		return 0, false, fmt.Errorf("%s must be a positive migration version", flagName)
	}
	return target, down, nil
}

func (raw rawOptions) validateEntryWriters() error {
	if raw.entryWriterProtocol < 0 || raw.entryWriterProtocol > 1 || raw.rollbackEntryWriterProtocol < 0 || raw.rollbackEntryWriterProtocol > 1 {
		return errors.New("entry writer protocol must be 0 or 1")
	}
	if raw.enforceEntryOwnership != "" && (raw.entryWriterProtocol != 1 || raw.rollbackEntryWriterProtocol != 1) {
		return errors.New("entry enforcement requires expanded candidate and rollback Sync writers")
	}
	return nil
}

func parseMigrationVersion(value string) (int64, error) {
	version, err := strconv.ParseInt(value, 10, 64)
	if err != nil || version < 1 {
		return 0, errors.New("--allow-missing-version must be a positive migration version")
	}
	if version > migrations.LatestVersion {
		return 0, fmt.Errorf("allow-missing migration %d is newer than this image's migration set", version)
	}
	return version, nil
}
