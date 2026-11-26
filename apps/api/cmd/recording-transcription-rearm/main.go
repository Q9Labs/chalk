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

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
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
	resources, err := openCommandResources(ctx, options.apply, stderr)
	if err != nil {
		return err
	}
	defer resources.close(stderr)
	ctx, batchSpan := resources.tracer.Start(ctx, "recording.transcription.rearm", trace.WithAttributes(attribute.String("chalk.journey.id", rearmJourneyID(ctx).String())))
	defer batchSpan.End()
	inventory, err := loadInventory(ctx, resources.repository, options)
	if err != nil {
		return err
	}
	result := report{DryRun: !options.apply, Recordings: []recordingOutcome{}}
	recordMissingRecordings(&result, inventory.missing)
	if err := processInventory(ctx, resources, options, inventory, &result); err != nil {
		return errors.Join(writeReport(out, result), err)
	}
	return writeReport(out, result)
}
