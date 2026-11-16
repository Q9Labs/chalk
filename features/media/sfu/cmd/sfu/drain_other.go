//go:build !unix

package main

import "os"

// notifyDrain does nothing, because this platform has no SIGUSR1.
func notifyDrain(drain chan<- os.Signal) {}
