// recording-transcription-rearm inventories expired transcription preparations. It is read-only unless --apply is explicit.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "recording-transcription-rearm:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out, stderr io.Writer) error {
	options, err := parseCommandOptions(args)
	if err != nil {
		return err
	}
	ctx, cancel, err := rearmCommandContext(ctx, options.timeout)
	if err != nil {
		return err
	}
	defer cancel()
	runtime, err := openCommandRuntime(ctx, options.apply, stderr)
	if err != nil {
		return err
	}
	defer runtime.close(stderr)
	ctx = runtime.ctx
	inventory, err := loadInventory(ctx, runtime.repository, options)
	if err != nil {
		return err
	}
	result := report{DryRun: !options.apply, Recordings: []recordingOutcome{}}
	recordMissingRecordings(&result, inventory.missing)
	if err := processInventory(ctx, runtime.commandResources, options, inventory, &result); err != nil {
		return errors.Join(writeReport(out, result), err)
	}
	return writeReport(out, result)
}
