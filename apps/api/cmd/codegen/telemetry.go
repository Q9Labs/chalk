package main

import (
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/sdktelemetry"
)

// applyTelemetryConstraints bounds the fields of the telemetry route and of the old call-stats
// route, whose samples are the same stats windows.
func applyTelemetryConstraints(schema map[string]any, schemaName string, fieldName string) {
	switch schemaName {
	case "CallStatsRequest":
		switch fieldName {
		case "version":
			schema["enum"] = []int{sdktelemetry.Version}
		case "samples":
			schema["minItems"] = 1
			schema["maxItems"] = httpapi.CallStatsSampleLimit
		case "window_ms":
			schema["minimum"] = sdktelemetry.MinWindowMS
			schema["maximum"] = sdktelemetry.MaxWindowMS
		default:
			applyTelemetryRange(schema, fieldName)
		}
	case "TelemetryRequest":
		switch fieldName {
		case "version":
			schema["enum"] = []int{sdktelemetry.Version, sdktelemetry.LedgerVersion}
		case "events":
			schema["minItems"] = 0
			schema["maxItems"] = sdktelemetry.EventLimit
			schema["description"] = "Version 1 requires 1 to 100 events. Version 2 allows 0 to 100, and an empty list only when end is set."
		case "dropped_seqs":
			schema["maxItems"] = sdktelemetry.MaxDropRanges
		case "tracks":
			schema["maxItems"] = sdktelemetry.MaxTracks
		case "mid":
			schema["pattern"] = sdktelemetry.MIDPattern
		default:
			applyTelemetryRange(schema, fieldName)
		}
	}
}

func applyTelemetryRange(schema map[string]any, fieldName string) {
	if low, high, numeric := sdktelemetry.FieldRange(fieldName); numeric {
		schema["minimum"] = low
		schema["maximum"] = high
	}
}

func telemetryFieldEnum(schemaName string, fieldName string) []string {
	if schemaName == "CallStatsRequest" || schemaName == "TelemetryRequest" {
		return sdktelemetry.FieldEnum(fieldName)
	}
	return nil
}
