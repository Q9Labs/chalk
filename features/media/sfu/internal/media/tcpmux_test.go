package media

import (
	"bytes"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
)

func testTCPLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func occupiedTCPAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener.Addr().String()
}

func TestListenTCPMuxKeepsTheListenersThatBind(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	mux, err := listenTCPMux([]string{occupiedTCPAddress(t), "127.0.0.1:0"}, log)
	if err != nil {
		t.Fatalf("one occupied listener stopped the other: %v", err)
	}
	if mux == nil {
		t.Fatal("no TCP mux")
	}
	_ = mux.Close()
	if !strings.Contains(logs.String(), "ICE-TCP listener unavailable") {
		t.Fatalf("the failed listener was not loud in the log: %q", logs.String())
	}
}

func TestListenTCPMuxFailsWhenNoListenerBinds(t *testing.T) {
	mux, err := listenTCPMux([]string{occupiedTCPAddress(t)}, testTCPLogger())
	if err == nil {
		_ = mux.Close()
		t.Fatal("an occupied only listener did not fail")
	}
}
