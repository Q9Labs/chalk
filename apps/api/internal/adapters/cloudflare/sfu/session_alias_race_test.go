package sfu

import (
	"context"
	"testing"
	"time"
)

// A proactive swap moves a connection to another Cloudflare session. It must never happen underneath a
// call that is already negotiating on the old one, or the client gets an answer for a session that later
// signaling no longer reaches.

func idleRegistry(t *testing.T) (*sessionRegistry, *time.Time) {
	t.Helper()
	clock := time.Unix(1_700_000_000, 0)
	registry := newSessionRegistry()
	registry.now = func() time.Time { return clock }
	registry.issue("conn")
	clock = clock.Add(sessionProbeLimit + time.Second)
	return registry, &clock
}

func newSessionFrom(ids ...string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) {
		id := ids[0]
		ids = ids[1:]
		return id, nil
	}
}

func TestProactiveSwapIsSkippedWhileAnotherCallIsInFlight(t *testing.T) {
	registry, _ := idleRegistry(t)
	endFirst := registry.begin("conn")
	defer endFirst()
	endSecond := registry.begin("conn")
	defer endSecond()

	fresh, created, err := registry.swap(context.Background(), "conn", "conn", func(context.Context) (string, error) {
		t.Fatal("no session may be created while another call negotiates on the old one")
		return "", nil
	}, true)
	if err != nil || fresh != "" || created {
		t.Fatalf("want no swap, got fresh=%q created=%v err=%v", fresh, created, err)
	}
	if got := registry.providerID("conn"); got != "conn" {
		t.Fatalf("the connection must stay on its own session, got %q", got)
	}
}

func TestProactiveSwapIsDiscardedWhenAnotherCallNegotiatesWhileItCreates(t *testing.T) {
	registry, _ := idleRegistry(t)
	end := registry.begin("conn")
	defer end()

	fresh, created, err := registry.swap(context.Background(), "conn", "conn", func(context.Context) (string, error) {
		registry.negotiated("conn") // the first call finished on the old session during the create
		return "fresh", nil
	}, true)
	if err != nil || fresh != "" || created {
		t.Fatalf("want the created session discarded, got fresh=%q created=%v err=%v", fresh, created, err)
	}
	if got := registry.providerID("conn"); got != "conn" {
		t.Fatalf("later calls must reach the session the first call used, got %q", got)
	}
}

func TestProactiveSwapIsDiscardedWhenAnotherCallStartsWhileItCreates(t *testing.T) {
	registry, _ := idleRegistry(t)
	end := registry.begin("conn")
	defer end()
	var endOther func()

	fresh, created, err := registry.swap(context.Background(), "conn", "conn", func(context.Context) (string, error) {
		endOther = registry.begin("conn") // a second call picks the old session during the create
		return "fresh", nil
	}, true)
	defer endOther()
	if err != nil || fresh != "" || created {
		t.Fatalf("want the created session discarded, got fresh=%q created=%v err=%v", fresh, created, err)
	}
	if got := registry.providerID("conn"); got != "conn" {
		t.Fatalf("the connection must stay on its own session, got %q", got)
	}
}

func TestSharedProactiveSwapIsReportedAsCreatedOnce(t *testing.T) {
	registry, _ := idleRegistry(t)
	create := newSessionFrom("fresh")

	first, createdFirst, err := registry.swap(context.Background(), "conn", "conn", create, true)
	if err != nil || first != "fresh" || !createdFirst {
		t.Fatalf("first caller must create: fresh=%q created=%v err=%v", first, createdFirst, err)
	}
	second, createdSecond, err := registry.swap(context.Background(), "conn", "conn", create, true)
	if err != nil || second != "fresh" || createdSecond {
		t.Fatalf("a waiting caller must reuse the session without creating: fresh=%q created=%v err=%v", second, createdSecond, err)
	}
}
