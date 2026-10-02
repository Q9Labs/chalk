// Command recording-bundle inspects a stored recording bundle file. It is
// read-only: it never writes next to the bundle and never contacts a service.
//
//	recording-bundle summarize <bundle>   per-track packet facts as JSON
//	recording-bundle replay <bundle>      inspect shared VP8 assembly and recovery (no pixel validation)
//	recording-bundle fixture <bundle>     print a sanitized VP8 fixture for decoder tests
//
// Encrypted bundles (CBE2 binary or JSON envelope) need a 32-byte key, as hex,
// in the file named by --key-file or in CHALK_RECORDING_BUNDLE_KEY_HEX.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingdecode"
)

const keyEnvironment = "CHALK_RECORDING_BUNDLE_KEY_HEX"

type bundleSummary struct {
	Version      string                         `json:"version"`
	RecordingID  string                         `json:"recording_id"`
	CaptureEpoch uint64                         `json:"capture_epoch"`
	Sequence     uint64                         `json:"sequence"`
	Tracks       []recordingdecode.TrackSummary `json:"tracks"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "recording-bundle: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: recording-bundle <summarize|replay|fixture> [--key-file path] <bundle>")
	}
	command := args[0]
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	keyFile := flags.String("key-file", "", "file holding the 32-byte bundle key as hex (default: $"+keyEnvironment+")")
	durationMS := flags.Int64("duration-ms", -1, "replay: positive recording-clock duration bound, without visibility spans (default: manifest media range end)")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("exactly one bundle file is required")
	}
	bundle, err := openBundle(flags.Arg(0), *keyFile)
	if err != nil {
		return err
	}
	switch command {
	case "summarize":
		return writeJSON(stdout, bundleSummary{
			Version: bundle.Version, RecordingID: bundle.Manifest.RecordingID, CaptureEpoch: bundle.Manifest.CaptureEpoch,
			Sequence: bundle.Manifest.Sequence, Tracks: recordingdecode.Summarize(bundle.Fragments),
		})
	case "replay":
		duration := *durationMS
		if duration < 0 {
			duration = bundle.Manifest.MediaRange.EndMilliseconds
		}
		results, err := recordingdecode.ReplayVP8(context.Background(), bundle.Fragments, duration)
		if err != nil {
			return err
		}
		if err := writeJSON(stdout, results); err != nil {
			return err
		}
		for _, result := range results {
			if result.Failure != nil {
				return fmt.Errorf("track %s epoch %d failed: %s", result.TrackID, result.Epoch, result.Failure.Error)
			}
		}
		return nil
	case "fixture":
		fixture, skipped, err := recordingdecode.NewFixture(bundle.Fragments)
		if err != nil {
			return err
		}
		for _, name := range skipped {
			fmt.Fprintf(stderr, "skipped non-VP8 track %s\n", name)
		}
		return writeJSON(stdout, fixture)
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func openBundle(path, keyFile string) (recordingbundle.Bundle, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return recordingbundle.Bundle{}, fmt.Errorf("read bundle: %w", err)
	}
	key, err := loadKey(keyFile)
	if err != nil {
		return recordingbundle.Bundle{}, err
	}
	bundle, err := recordingbundle.Open(encoded, key)
	if err != nil {
		return recordingbundle.Bundle{}, fmt.Errorf("open %s: %w", path, err)
	}
	return bundle, nil
}

func loadKey(keyFile string) ([]byte, error) {
	value := os.Getenv(keyEnvironment)
	if keyFile != "" {
		contents, err := os.ReadFile(keyFile)
		if err != nil {
			return nil, fmt.Errorf("read key file: %w", err)
		}
		value = string(contents)
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(value)
	if err != nil || len(key) != 32 {
		return nil, errors.New("bundle key must be 32 bytes encoded as 64 hex characters")
	}
	return key, nil
}

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
