package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/traceharness"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "api trace: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	color := flag.String("color", "auto", "text color: auto, always, or never")
	format := flag.String("format", "text", "output format: text or json")
	scenario := flag.String("scenario", traceharness.CreateTenantScenario, "scenario to run")
	flag.Parse()

	result, err := traceharness.Run(context.Background(), *scenario)
	if err != nil {
		return err
	}

	switch *format {
	case "text":
		useColor, err := shouldUseColor(*color)
		if err != nil {
			return err
		}
		return writeTextResult(result, useColor)
	case "json":
		return jsonResult(result)
	default:
		return fmt.Errorf("unknown format %q", *format)
	}
}

func writeTextResult(result traceharness.ScenarioResult, color bool) error {
	theme := cliTheme{enabled: color}
	fmt.Fprintf(os.Stdout, "%s\n", theme.paint("\x1b[1m", "Execution Trace Harness"))
	fmt.Fprintf(os.Stdout, "Scenario: %s\n", theme.paint("\x1b[36m", result.Name))
	fmt.Fprintf(os.Stdout, "Status:   %s\n", theme.paint(statusColor(result.StatusCode), fmt.Sprintf("%d", result.StatusCode)))
	fmt.Fprintf(os.Stdout, "Events:   %d\n\n", len(result.Events))
	fmt.Fprintln(os.Stdout, theme.paint("\x1b[1m", "Timeline"))
	return traceharness.WriteTextWithOptions(os.Stdout, result.Events, traceharness.TextOptions{
		Color: color,
	})
}

func jsonResult(result traceharness.ScenarioResult) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}

func shouldUseColor(mode string) (bool, error) {
	switch mode {
	case "always":
		return true, nil
	case "never":
		return false, nil
	case "auto":
		if os.Getenv("NO_COLOR") != "" {
			return false, nil
		}
		info, err := os.Stdout.Stat()
		if err != nil {
			return false, fmt.Errorf("inspect stdout: %w", err)
		}
		return info.Mode()&os.ModeCharDevice != 0, nil
	default:
		return false, fmt.Errorf("unknown color mode %q", mode)
	}
}

func statusColor(status int) string {
	switch {
	case status >= 200 && status < 300:
		return "\x1b[32m"
	case status >= 400:
		return "\x1b[31m"
	default:
		return "\x1b[33m"
	}
}

type cliTheme struct {
	enabled bool
}

func (t cliTheme) paint(style string, value string) string {
	if !t.enabled {
		return value
	}

	return style + value + "\x1b[0m"
}
