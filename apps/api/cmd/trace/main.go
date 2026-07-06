package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/traceharness"
)

const allScenarios = "all"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "api trace: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	color := flag.String("color", "auto", "text color: auto, always, or never")
	format := flag.String("format", "text", "output format: text or json")
	style := flag.String("style", "minimal", "timeline style: minimal or tree")
	scenario := flag.String("scenario", allScenarios, "scenario to run, or all")
	flag.Parse()

	results, err := runScenarios(context.Background(), *scenario)
	if err != nil {
		return err
	}

	switch *format {
	case "text":
		useColor, err := shouldUseColor(*color)
		if err != nil {
			return err
		}
		tree, err := useTree(*style)
		if err != nil {
			return err
		}
		return writeTextResults(os.Stdout, results, useColor, tree)
	case "json":
		return jsonResults(os.Stdout, results)
	default:
		return fmt.Errorf("unknown format %q", *format)
	}
}

func runScenarios(ctx context.Context, scenario string) ([]traceharness.ScenarioResult, error) {
	if scenario != allScenarios {
		result, err := traceharness.Run(ctx, scenario)
		if err != nil {
			return nil, err
		}
		return []traceharness.ScenarioResult{result}, nil
	}

	names := traceharness.ScenarioNames()
	results := make([]traceharness.ScenarioResult, 0, len(names))
	for _, name := range names {
		result, err := traceharness.Run(ctx, name)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}

func writeTextResults(w io.Writer, results []traceharness.ScenarioResult, color bool, tree bool) error {
	for index, result := range results {
		if index > 0 {
			fmt.Fprintln(w)
			fmt.Fprintln(w, "---")
			fmt.Fprintln(w)
		}
		if err := writeTextResult(w, result, color, tree); err != nil {
			return err
		}
	}
	return nil
}

func writeTextResult(w io.Writer, result traceharness.ScenarioResult, color bool, tree bool) error {
	theme := cliTheme{enabled: color}
	label := func(text string) string { return theme.paint("\x1b[2m", text) }
	fmt.Fprintf(w, "%s\n", theme.paint("\x1b[1m", "Execution Trace Harness"))
	fmt.Fprintf(w, "%s %s\n", label("Scenario:"), theme.paint("\x1b[36m", result.Name))
	fmt.Fprintf(w, "%s   %s\n", label("Status:"), theme.paint(statusColor(result.StatusCode), fmt.Sprintf("%d", result.StatusCode)))
	fmt.Fprintf(w, "%s   %d\n\n", label("Events:"), len(result.Events))
	fmt.Fprintln(w, theme.paint("\x1b[1m", "Timeline"))
	return traceharness.WriteTextWithOptions(w, result.Events, traceharness.TextOptions{
		Color: color,
		Tree:  tree,
	})
}

func jsonResults(w io.Writer, results []traceharness.ScenarioResult) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	if len(results) == 1 {
		return encoder.Encode(results[0])
	}
	return encoder.Encode(results)
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

func useTree(style string) (bool, error) {
	switch style {
	case "minimal":
		return false, nil
	case "tree":
		return true, nil
	default:
		return false, fmt.Errorf("unknown style %q", style)
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
