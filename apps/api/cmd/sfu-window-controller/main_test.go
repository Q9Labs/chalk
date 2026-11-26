package main

import (
	"net"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestNotifySystemdReady(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("sd_notify is Linux-only")
	}
	path := filepath.Join(t.TempDir(), "notify.sock")
	listener, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	t.Setenv("NOTIFY_SOCKET", path)
	if err := notifySystemdReady(); err != nil {
		t.Fatal(err)
	}
	if err := listener.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	n, err := listener.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "READY=1" {
		t.Fatalf("unexpected readiness notification %q", buf[:n])
	}
}
