//go:build unix

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// notifyDrain delivers SIGUSR1 to drain.
func notifyDrain(drain chan<- os.Signal) {
	signal.Notify(drain, syscall.SIGUSR1)
}
