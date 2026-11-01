package sfu

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A claim moves a connection to another Cloudflare session only when no call runs on the old one, so a
// swap never lands underneath a call that is negotiating on it.

type claimResult struct {
	session string
	swapped bool
	release func()
	err     error
}

func claimAsync(ctx context.Context, registry *sessionRegistry, create func(context.Context) (string, error)) <-chan claimResult {
	done := make(chan claimResult, 1)
	go func() {
		session, swapped, release, err := registry.claim(ctx, "conn", create)
		done <- claimResult{session, swapped, release, err}
	}()
	return done
}

func newSessionFrom(ids ...string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) {
		id := ids[0]
		ids = ids[1:]
		return id, nil
	}
}

func neverCreate(t *testing.T) func(context.Context) (string, error) {
	return func(context.Context) (string, error) {
		t.Error("no session may be created in this case")
		return "", errors.New("unexpected create")
	}
}

func expectPending(t *testing.T, done <-chan claimResult) {
	t.Helper()
	select {
	case got := <-done:
		t.Fatalf("the claim must wait for the call in flight, got %+v", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func expectClaim(t *testing.T, done <-chan claimResult) claimResult {
	t.Helper()
	select {
	case got := <-done:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("the claim never finished")
		return claimResult{}
	}
}

// inFlightThenIdle returns a registry with one call running on a session that was young when it started
// and has since passed the probe limit.
func inFlightThenIdle(t *testing.T) (registry *sessionRegistry, endFirst func()) {
	t.Helper()
	clock := time.Unix(1_700_000_000, 0)
	registry = newSessionRegistry()
	registry.now = func() time.Time { return clock }
	registry.issue("conn")
	_, _, endFirst, err := registry.claim(context.Background(), "conn", neverCreate(t))
	if err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(sessionProbeLimit + time.Second)
	return registry, endFirst
}

func TestClaimOnAnExpiredSessionWaitsForTheCallInFlightThenSwaps(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	second := claimAsync(context.Background(), registry, newSessionFrom("fresh"))
	expectPending(t, second)

	endFirst() // the first call ended without negotiating

	got := expectClaim(t, second)
	if got.err != nil || got.session != "fresh" || !got.swapped {
		t.Fatalf("want a swap to the fresh session, got %+v", got)
	}
}

func TestClaimFollowsTheCallInFlightWhenItNegotiates(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	second := claimAsync(context.Background(), registry, neverCreate(t))
	expectPending(t, second)

	registry.negotiated("conn")
	endFirst()

	got := expectClaim(t, second)
	if got.err != nil || got.session != "conn" || got.swapped {
		t.Fatalf("want the session the first call negotiated on, got %+v", got)
	}
}

func TestClaimFollowsTheCallInFlightWhenItsSessionMoves(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	second := claimAsync(context.Background(), registry, neverCreate(t))
	expectPending(t, second)

	if _, replaced, err := registry.replace(context.Background(), "conn", "conn", newSessionFrom("moved")); err != nil || !replaced {
		t.Fatalf("setup: replace failed: replaced=%v err=%v", replaced, err)
	}
	endFirst()

	got := expectClaim(t, second)
	if got.err != nil || got.session != "moved" || got.swapped {
		t.Fatalf("want the session the first call moved to, got %+v", got)
	}
}

func TestClaimWaitEndsWhenTheContextIsCanceledAndLeavesTheConnectionUsable(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	ctx, cancel := context.WithCancel(context.Background())
	second := claimAsync(ctx, registry, neverCreate(t))
	expectPending(t, second)

	cancel()

	if got := expectClaim(t, second); !errors.Is(got.err, context.Canceled) || got.release != nil {
		t.Fatalf("want the cancellation and no registration, got %+v", got)
	}
	endFirst()
	third := expectClaim(t, claimAsync(context.Background(), registry, newSessionFrom("fresh")))
	if third.err != nil || third.session != "fresh" || !third.swapped {
		t.Fatalf("a canceled wait must not block later calls, got %+v", third)
	}
}

func TestClaimGivesAFailedCreationTheOldSession(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	endFirst()

	got := expectClaim(t, claimAsync(context.Background(), registry, func(context.Context) (string, error) { return "", errors.New("rate limited") }))

	if got.err != nil || got.session != "conn" || got.swapped {
		t.Fatalf("want the old session without an error, got %+v", got)
	}
}

func TestClaimDiscardsTheCreatedSessionWhenTheConnectionNegotiatesWhileItCreates(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	endFirst()

	got := expectClaim(t, claimAsync(context.Background(), registry, func(context.Context) (string, error) {
		registry.negotiated("conn") // another signaling call finished on the old session during the create
		return "fresh", nil
	}))

	if got.err != nil || got.session != "conn" || got.swapped {
		t.Fatalf("want the session the connection negotiated on, got %+v", got)
	}
	if id := registry.providerID("conn"); id != "conn" {
		t.Fatalf("later calls must reach the negotiated session, got %q", id)
	}
}

func TestClaimsDuringACreationShareItsSession(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	endFirst()
	creating, proceed := make(chan struct{}), make(chan struct{})
	first := claimAsync(context.Background(), registry, func(context.Context) (string, error) {
		close(creating)
		<-proceed
		return "fresh", nil
	})
	<-creating
	second := claimAsync(context.Background(), registry, neverCreate(t))
	expectPending(t, second)

	close(proceed)

	one, two := expectClaim(t, first), expectClaim(t, second)
	if one.session != "fresh" || !one.swapped || two.session != "fresh" || two.swapped {
		t.Fatalf("the creating call swaps and the waiting call reuses it: %+v %+v", one, two)
	}
}

func TestClaimFollowsASwappedConnectionThatNegotiatesWhileItWaits(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	if _, replaced, err := registry.replace(context.Background(), "conn", "conn", newSessionFrom("moved")); err != nil || !replaced {
		t.Fatalf("setup: replace failed: replaced=%v err=%v", replaced, err)
	}
	clock := registry.now()
	registry.now = func() time.Time { return clock.Add(sessionProbeLimit + time.Second) } // the moved session is idle too
	second := claimAsync(context.Background(), registry, neverCreate(t))
	expectPending(t, second)

	registry.negotiated("conn") // a swapped entry stays and is marked negotiated
	endFirst()

	got := expectClaim(t, second)
	if got.err != nil || got.session != "moved" || got.swapped {
		t.Fatalf("want the negotiated session without a swap, got %+v", got)
	}
}

func TestFailedCreationInAClaimReleasesTheGate(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	endFirst()
	failed := expectClaim(t, claimAsync(context.Background(), registry, func(context.Context) (string, error) { return "", errors.New("rate limited") }))
	failed.release()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	next := expectClaim(t, claimAsync(ctx, registry, newSessionFrom("fresh")))

	if next.err != nil || next.session != "fresh" || !next.swapped {
		t.Fatalf("a failed create must not block later calls, got %+v", next)
	}
}

func TestReplaceDiscardsTheCreatedSessionWhenTheConnectionNegotiatesDuringTheCreate(t *testing.T) {
	registry, endFirst := inFlightThenIdle(t)
	endFirst()
	fresh, replaced, err := registry.replace(context.Background(), "conn", "conn", func(context.Context) (string, error) {
		registry.negotiated("conn")
		return "fresh", nil
	})
	if err != nil || replaced || fresh != "" {
		t.Fatalf("want no replacement, got fresh=%q replaced=%v err=%v", fresh, replaced, err)
	}
	if got := registry.providerID("conn"); got != "conn" {
		t.Fatalf("the connection must keep the session it negotiated on, now %q", got)
	}
	if got := registry.clientID("fresh"); got != "fresh" {
		t.Fatalf("the discarded session must not be aliased, got %q", got)
	}
}
