package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: chalk-healthcheck <url>")
		os.Exit(2)
	}

	client := http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "health request failed")
		os.Exit(1)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
	if response.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "health endpoint returned a non-200 status")
		os.Exit(1)
	}
}
