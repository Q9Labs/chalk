package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordernodebootstrap"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "chalk-recorder-bootstrap:", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	flags := flag.NewFlagSet("chalk-recorder-bootstrap", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	oneTime := flags.Bool("one-time", false, "bootstrap a new recorder node identity")
	renew := flags.Bool("renew", false, "renew the current recorder node identity")
	requireSignedAssertion := flags.Bool("require-signed-assertion", false, "require the signed node proof protocol")
	requireInventoryMatch := flags.Bool("require-droplet-inventory-match", false, "require issuer-side live Droplet inventory matching")
	requireBootGeneration := flags.Bool("require-boot-generation", false, "require the controller boot generation fence")
	environmentFile := flags.String("env-file", "/etc/chalk-recorder/node.env", "node release environment file")
	imageEnvironmentFile := flags.String("image-env-file", "/etc/chalk-recorder/image.env", "immutable image environment file")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return recordernodebootstrap.ErrInvalidConfig
	}
	if *oneTime == *renew {
		return errors.New("exactly one of --one-time or --renew is required")
	}
	if *oneTime && (!*requireSignedAssertion || !*requireInventoryMatch || !*requireBootGeneration) {
		return errors.New("one-time bootstrap requires signed proof, live inventory, and boot-generation fences")
	}
	loadConfig := recordernodebootstrap.LoadConfig
	if *renew {
		loadConfig = recordernodebootstrap.LoadRenewalConfig
	}
	config, err := loadConfig(*environmentFile, *imageEnvironmentFile)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	timeout := 9 * time.Minute
	if *renew {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if *oneTime {
		return recordernodebootstrap.Bootstrap(ctx, config)
	}
	return recordernodebootstrap.Renew(ctx, config)
}
