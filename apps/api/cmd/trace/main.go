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
	format := flag.String("format", "text", "output format: text or json")
	scenario := flag.String("scenario", traceharness.CreateTenantScenario, "scenario to run")
	flag.Parse()

	result, err := traceharness.Run(context.Background(), *scenario)
	if err != nil {
		return err
	}

	switch *format {
	case "text":
		fmt.Fprintf(os.Stdout, "Execution Trace Harness: %s\nHTTP status: %d\n\n", result.Name, result.StatusCode)
		return traceharness.WriteText(os.Stdout, result.Events)
	case "json":
		return jsonResult(result)
	default:
		return fmt.Errorf("unknown format %q", *format)
	}
}

func jsonResult(result traceharness.ScenarioResult) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}
