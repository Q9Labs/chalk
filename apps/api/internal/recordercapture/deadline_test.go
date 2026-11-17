package recordercapture

import (
	"context"
	"testing"
	"time"
)

func TestCoordinatorFollowsALaterPlanDeadline(t *testing.T) {
	attempt := newAttempt(t)
	coordinator := newCoordinator(t, attempt, &fakeSignaling{}, &fakePeer{}, Config{})
	signed := attempt.HardDeadline
	if !attempt.EndsAt().Equal(signed) {
		t.Fatalf("capture ends at %v before any plan, want the signed %v", attempt.EndsAt(), signed)
	}
	extended := signed.Add(90 * time.Minute)
	if _, err := coordinator.Bootstrap(context.Background(), newPlanWithDeadline(t, attempt, 1, []planTrack{{name: "one"}}, extended)); err != nil {
		t.Fatalf("bootstrap on a plan that ends later than the signed deadline: %v", err)
	}
	if !attempt.EndsAt().Equal(extended) {
		t.Fatalf("capture ends at %v, want the plan's %v", attempt.EndsAt(), extended)
	}
	select {
	case <-attempt.DeadlineMoved():
	default:
		t.Fatal("the capture was not told its end moved")
	}
	if _, err := coordinator.Reconcile(context.Background(), newPlanWithDeadline(t, attempt, 2, []planTrack{{name: "one"}}, signed.Add(time.Minute))); err != nil {
		t.Fatalf("reconcile on a plan that ends earlier: %v", err)
	}
	if !attempt.EndsAt().Equal(extended) {
		t.Fatalf("an earlier plan moved the end to %v, want it kept at %v", attempt.EndsAt(), extended)
	}
}
