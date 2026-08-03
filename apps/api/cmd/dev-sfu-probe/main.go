package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Stdout, os.Getenv); err != nil {
		fmt.Fprintf(os.Stderr, "dev-sfu-probe: %v\n", err)
		os.Exit(1)
	}
}

func run(output io.Writer, env func(string) string) error {
	client, err := NewClientFromEnv(env)
	if err != nil {
		return err
	}

	result, err := NewProbe(client).Run(context.Background())
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}
