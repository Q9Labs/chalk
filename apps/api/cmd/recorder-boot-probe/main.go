package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/recorderbootprobe"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "recorder boot probe failed:", err)
		os.Exit(1)
	}
}

func run() error {
	var input recorderbootprobe.Input
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	result, err := recorderbootprobe.Run(ctx, input, os.Getenv("DIGITALOCEAN_TOKEN"))
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
