package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

const operationTimeout = 20 * time.Minute

func main() {
	options, err := parseOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "showcase dataset configuration failed: %v\n", err)
		os.Exit(2)
	}

	value, err := loadDataset(options)
	if err != nil {
		fmt.Fprintf(os.Stderr, "showcase dataset validation failed: %v\n", err)
		os.Exit(2)
	}
	if err := validateOrganizationKey(value, options.organizationKey); err != nil {
		fmt.Fprintf(os.Stderr, "showcase dataset configuration failed: %v\n", err)
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()

	result, err := runCommand(ctx, value, options)
	if err != nil {
		fmt.Fprintf(os.Stderr, "showcase dataset %s failed: %v\n", options.command, err)
		os.Exit(1)
	}
	if err := printReport(result, options.jsonOutput); err != nil {
		fmt.Fprintf(os.Stderr, "showcase dataset report failed: %v\n", err)
		os.Exit(1)
	}
}

func runCommand(ctx context.Context, value dataset, options options) (report, error) {
	switch options.command {
	case "plan":
		return planDataset(value, options), nil
	case "apply":
		return applyDataset(ctx, value, options)
	case "verify":
		return verifyDataset(ctx, value, options)
	case "remove":
		return removeDataset(ctx, value, options)
	default:
		return report{}, fmt.Errorf("unsupported command %q", options.command)
	}
}

func validateOrganizationKey(value dataset, organizationKey string) error {
	if len(value.Manifest.Records.Organizations) != 1 {
		return fmt.Errorf("manifest organization count is %d", len(value.Manifest.Records.Organizations))
	}
	if organizationKey != value.Manifest.Records.Organizations[0].ExternalKey {
		return fmt.Errorf("--organization-key must equal %s", value.Manifest.Records.Organizations[0].ExternalKey)
	}
	return nil
}

func baseReport(value dataset, options options, command string) report {
	counts := map[string]int{
		"organizations": len(value.Manifest.Records.Organizations),
		"tenants":       len(value.Manifest.Records.Tenants),
		"spaces":        len(value.Manifest.Records.Spaces),
		"users":         len(value.Manifest.Records.Users),
		"agents":        len(value.Manifest.Records.Agents),
		"episodes":      len(value.Manifest.Records.Episodes),
		"artifacts":     len(value.Manifest.Records.Artifacts),
		"assets":        len(value.Assets.Assets),
		"builtAssets":   value.Assets.Counts.Built,
		"pendingAssets": value.Assets.Counts.PendingProductCapture,
	}
	return report{
		Command:         command,
		DatasetID:       value.Manifest.DatasetID,
		DatasetVersion:  value.Manifest.DatasetVersion,
		Product:         value.Manifest.Product,
		Environment:     options.environment,
		OrganizationKey: options.organizationKey,
		ManifestHash:    "sha256:" + fmt.Sprintf("%x", value.ManifestHash[:]),
		AssetsHash:      "sha256:" + fmt.Sprintf("%x", value.AssetsHash[:]),
		Counts:          counts,
		PendingAssets:   pendingAssetKeys(value),
		Packs:           value.Manifest.TargetedPacks,
		Status:          "planned",
	}
}

func planDataset(value dataset, options options) report {
	result := baseReport(value, options, "plan")
	result.Message = "native Chalk tenants, spaces, identities, episodes, participants, chat, reactions, whiteboards, and available artifacts are ready to apply; nine product-capture slots remain unreferenced"
	return result
}

func printReport(value report, jsonOutput bool) error {
	if jsonOutput {
		encoded, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(encoded))
		return nil
	}
	fmt.Printf("%s %s/%s %s status=%s tenants=%d spaces=%d episodes=%d built-assets=%d pending-assets=%d\n", value.Command, value.Product, value.DatasetVersion, value.Environment, value.Status, value.Counts["tenants"], value.Counts["spaces"], value.Counts["episodes"], value.Counts["builtAssets"], value.Counts["pendingAssets"])
	if value.OrganizationID != "" {
		fmt.Printf("organization=%s\n", value.OrganizationID)
	}
	if value.Message != "" {
		fmt.Println(value.Message)
	}
	return nil
}
