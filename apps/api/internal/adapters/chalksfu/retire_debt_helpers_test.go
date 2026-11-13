package chalksfu_test

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// partition is a TCP relay in front of a node's control port. Severing it drops every open
// connection and refuses new ones until it heals, as a network partition between the API and one
// node does, while the node itself keeps running and keeps its sessions.
type partition struct {
	listener net.Listener
	target   string
	mu       sync.Mutex
	severed  bool
	open     []net.Conn
}

func newPartition(t *testing.T, controlURL string) *partition {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &partition{listener: listener, target: strings.TrimPrefix(controlURL, "https://")}
	t.Cleanup(func() { _ = listener.Close(); p.drop() })
	go p.serve()
	return p
}

func (p *partition) url() string { return "https://" + p.listener.Addr().String() }

func (p *partition) serve() {
	for {
		client, err := p.listener.Accept()
		if err != nil {
			return
		}
		p.mu.Lock()
		severed := p.severed
		p.mu.Unlock()
		upstream, dialErr := net.Dial("tcp", p.target)
		if severed || dialErr != nil {
			_ = client.Close()
			continue
		}
		p.mu.Lock()
		p.open = append(p.open, client, upstream)
		p.mu.Unlock()
		go func() { _, _ = io.Copy(upstream, client); _ = upstream.Close() }()
		go func() { _, _ = io.Copy(client, upstream); _ = client.Close() }()
	}
}

func (p *partition) drop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, conn := range p.open {
		_ = conn.Close()
	}
	p.open = nil
}

func (p *partition) sever() {
	p.mu.Lock()
	p.severed = true
	p.mu.Unlock()
	p.drop()
}

func (p *partition) heal() {
	p.mu.Lock()
	p.severed = false
	p.mu.Unlock()
}

// failingDebts fails the debt write the Episode's end makes. With afterWrite the debt is stored
// first and the error comes after, as a crash between the write and its acknowledgement would.
type failingDebts struct {
	*recoveryStore
	fail       bool
	afterWrite bool
}

func (f *failingDebts) RecordRetirementDebts(ctx context.Context, debts []mediaplane.RetirementDebt) error {
	if !f.fail {
		return f.recoveryStore.RecordRetirementDebts(ctx, debts)
	}
	if f.afterWrite {
		if err := f.recoveryStore.RecordRetirementDebts(ctx, debts); err != nil {
			return err
		}
	}
	return errors.New("injected fault")
}
