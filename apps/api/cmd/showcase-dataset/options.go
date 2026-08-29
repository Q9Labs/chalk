package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

type options struct {
	command             string
	pack                string
	environment         string
	organizationKey     string
	organizationID      string
	ownerUserID         string
	databaseURL         string
	assetRoot           string
	manifestPath        string
	assetsManifestPath  string
	checksumsPath       string
	jsonOutput          bool
	createOrganization  bool
	confirmProduction   bool
	confirmOrganization string
	skipAssetUpload     bool
	skipStorageVerify   bool
	skipStorageDelete   bool
}

func parseOptions(args []string) (options, error) {
	if len(args) == 0 {
		return options{}, errors.New("usage: showcase-dataset <plan|apply|verify|remove> [flags]")
	}
	command := args[0]
	if command != "plan" && command != "apply" && command != "verify" && command != "remove" {
		return options{}, fmt.Errorf("unsupported command %q", command)
	}
	flags := flag.NewFlagSet("chalk-showcase-dataset", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	value := options{
		command:     command,
		pack:        showcaseDatasetID,
		environment: "current",
		databaseURL: os.Getenv("CHALK_DATABASE_URL"),
		ownerUserID: os.Getenv("CHALK_SHOWCASE_OWNER_USER_ID"),
	}
	flags.StringVar(&value.pack, "pack", value.pack, "dataset pack to operate on")
	flags.StringVar(&value.environment, "environment", value.environment, "target environment: local, hosted-dev, current, or production")
	flags.StringVar(&value.organizationKey, "organization-key", "", "explicit new showcase organization key")
	flags.StringVar(&value.organizationID, "organization-id", "", "resolved showcase organization id")
	flags.StringVar(&value.ownerUserID, "owner-user-id", value.ownerUserID, "existing Chalk account user id to own the new tenants")
	flags.StringVar(&value.databaseURL, "database-url", value.databaseURL, "dedicated Chalk Postgres URL")
	flags.StringVar(&value.assetRoot, "asset-root", defaultAssetRoot(), "absolute root containing the built showcase assets")
	flags.StringVar(&value.manifestPath, "manifest", "", "override the embedded Chalk manifest")
	flags.StringVar(&value.assetsManifestPath, "assets-manifest", "", "override the embedded Chalk asset manifest")
	flags.StringVar(&value.checksumsPath, "checksums", "", "override the embedded showcase checksums")
	flags.BoolVar(&value.jsonOutput, "json", false, "print machine-readable output")
	flags.BoolVar(&value.createOrganization, "create-organization", false, "allow creating the new organization boundary")
	flags.BoolVar(&value.confirmProduction, "confirm-production", false, "confirm a production write or removal")
	flags.StringVar(&value.confirmOrganization, "confirm-organization", "", "exact resolved organization id required for removal")
	flags.BoolVar(&value.skipAssetUpload, "skip-asset-upload", false, "skip R2 upload; only allowed for local dry runs")
	flags.BoolVar(&value.skipStorageVerify, "skip-storage-verify", false, "skip R2 object checks during verify")
	flags.BoolVar(&value.skipStorageDelete, "skip-storage-delete", false, "skip R2 object deletion during remove")
	if err := flags.Parse(args[1:]); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 {
		return options{}, errors.New("unexpected positional arguments")
	}
	if value.pack != showcaseDatasetID {
		return options{}, fmt.Errorf("unsupported pack %q: only %s is available", value.pack, showcaseDatasetID)
	}
	switch value.environment {
	case "local", "hosted-dev", "current", "production":
	default:
		return options{}, fmt.Errorf("unsupported environment %q", value.environment)
	}
	if value.organizationKey == "" {
		return options{}, errors.New("--organization-key is required")
	}
	if !filepath.IsAbs(value.assetRoot) {
		return options{}, errors.New("--asset-root must be absolute")
	}
	if command == "apply" {
		if !value.createOrganization {
			return options{}, errors.New("apply requires --create-organization")
		}
		if value.databaseURL == "" {
			return options{}, errors.New("apply requires --database-url or CHALK_DATABASE_URL")
		}
		if value.ownerUserID == "" {
			return options{}, errors.New("apply requires --owner-user-id or CHALK_SHOWCASE_OWNER_USER_ID")
		}
		if value.environment == "production" && !value.confirmProduction {
			return options{}, errors.New("production apply requires --confirm-production")
		}
		if value.skipAssetUpload && value.environment != "local" {
			return options{}, errors.New("--skip-asset-upload is only allowed for local applies")
		}
	}
	if command == "verify" || command == "remove" {
		if value.databaseURL == "" {
			return options{}, fmt.Errorf("%s requires --database-url or CHALK_DATABASE_URL", command)
		}
	}
	if command == "remove" {
		if value.confirmOrganization == "" {
			return options{}, errors.New("remove requires --confirm-organization")
		}
		if value.environment == "production" && !value.confirmProduction {
			return options{}, errors.New("production remove requires --confirm-production")
		}
	}
	if command == "verify" && value.organizationID != "" && value.confirmOrganization != "" {
		return options{}, errors.New("--organization-id and --confirm-organization cannot be combined")
	}
	if value.environment != "local" && (value.skipStorageVerify || value.skipStorageDelete) {
		return options{}, errors.New("storage verification and deletion may only be skipped for local runs")
	}
	return value, nil
}

func defaultAssetRoot() string {
	if value := os.Getenv("CHALK_SHOWCASE_ASSET_ROOT"); value != "" {
		return value
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		return ""
	}
	for directory := workingDirectory; ; directory = filepath.Dir(directory) {
		candidate := filepath.Join(directory, "build", "assets")
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			absolute, absErr := filepath.Abs(candidate)
			if absErr == nil {
				return absolute
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
	}
	return filepath.Join(workingDirectory, "build", "assets")
}
