// Command benchnode runs the real SFU control service and media node (the same
// control.Start that cmd/sfu runs) with measurement added: pprof on a loopback
// address, and a once-a-second JSON line of host, process and Go runtime counters.
// It is for load tests only; the production binary stays cmd/sfu.
//
// Settings are the SFU_* variables of cmd/sfu plus:
//
//	BENCH_PPROF_ADDR    loopback address for pprof (default 127.0.0.1:6060)
//	BENCH_SAMPLES_FILE  where to append samples (default samples.jsonl)
//	BENCH_NET_IFACE     public network interface to count (default eth0)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof" // registers the pprof handlers on the default mux, served on loopback only
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/control"
	"github.com/q9labs/chalk/features/media/sfu/tests/load/hostmetrics"
)

// sample is one line of the samples file.
type sample struct {
	hostmetrics.Sample
	HeapAllocBytes uint64  `json:"heapAllocBytes"`
	HeapInuseBytes uint64  `json:"heapInuseBytes"`
	HeapSysBytes   uint64  `json:"heapSysBytes"`
	GCCount        uint32  `json:"gcCount"`
	GCPauseTotalNs uint64  `json:"gcPauseTotalNs"`
	GCPauseMaxNs   uint64  `json:"gcPauseMaxNs"` // longest pause since the previous sample
	Goroutines     int     `json:"goroutines"`
	Mallocs        uint64  `json:"mallocs"`
	GCCPUFraction  float64 `json:"gcCpuFraction"`
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("benchnode stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		return err
	}
	server, err := control.Start(cfg, log)
	if err != nil {
		return err
	}
	log.Info("benchnode listening", "control", server.Addr().String(), "udpPort", server.UDPPort())

	pprofServer, err := startPprof(env("BENCH_PPROF_ADDR", "127.0.0.1:6060"))
	if err != nil {
		return errors.Join(err, server.Stop(context.Background()))
	}
	output, err := os.OpenFile(env("BENCH_SAMPLES_FILE", "samples.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return errors.Join(fmt.Errorf("open samples file: %w", err), server.Stop(context.Background()))
	}
	defer output.Close()

	signals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go sampleLoop(signals, hostmetrics.NewReader(env("BENCH_NET_IFACE", "eth0")), json.NewEncoder(output))
	<-signals.Done()

	log.Info("benchnode draining")
	_ = pprofServer.Close()
	return server.Stop(context.Background())
}

// startPprof serves pprof, and refuses any address that is not loopback.
func startPprof(address string) (*http.Server, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("pprof address %q: %w", address, err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("pprof address %q is not a loopback IP", address)
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, fmt.Errorf("listen for pprof: %w", err)
	}
	server := &http.Server{Handler: http.DefaultServeMux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return server, nil
}

func sampleLoop(ctx context.Context, reader *hostmetrics.Reader, out *json.Encoder) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var lastGC uint32
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		var longest uint64
		for gc := lastGC + 1; gc <= memory.NumGC && memory.NumGC-gc < uint32(len(memory.PauseNs)); gc++ {
			longest = max(longest, memory.PauseNs[(gc+255)%256])
		}
		lastGC = memory.NumGC
		line := sample{
			Sample:         reader.Next(),
			HeapAllocBytes: memory.HeapAlloc,
			HeapInuseBytes: memory.HeapInuse,
			HeapSysBytes:   memory.HeapSys,
			GCCount:        memory.NumGC,
			GCPauseTotalNs: memory.PauseTotalNs,
			GCPauseMaxNs:   longest,
			Goroutines:     runtime.NumGoroutine(),
			Mallocs:        memory.Mallocs,
			GCCPUFraction:  memory.GCCPUFraction,
		}
		if err := out.Encode(line); err != nil {
			slog.Error("write sample", "error", err)
			return
		}
	}
}

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}
