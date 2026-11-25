package sfufleet

import (
	"testing"
	"time"
)

func TestPlanWindow(t *testing.T) {
	now := time.Unix(0, 0)
	book := func(start, end, participants int) Booking {
		return Booking{StartsAt: now.Add(time.Duration(start) * time.Minute), EndsAt: now.Add(time.Duration(end) * time.Minute), Participants: participants}
	}
	capacity := Capacity{StandingSlots: 8, SlotsPerNode: 4, SpareSlots: 4, MaxNodes: 5}
	t.Run("prewarms a 20-class window and returns to the standing floor", func(t *testing.T) {
		bookings := make([]Booking, 20)
		for i := range bookings {
			bookings[i] = book(20, 260, 3)
		}
		demand := Demand{Bookings: bookings}
		if got := PlanWindow(demand, capacity, now, 25*time.Minute); got != (Plan{20, 4, 4}) {
			t.Fatalf("inside lookahead: got %+v", got)
		}
		if got := PlanWindow(demand, capacity, now, 15*time.Minute); got != (Plan{}) {
			t.Fatalf("before lookahead: got %+v", got)
		}
		if got := PlanWindow(demand, capacity, now.Add(260*time.Minute), 25*time.Minute); got != (Plan{}) {
			t.Fatalf("after expected end: got %+v", got)
		}
	})
	t.Run("uses peak not sum and accounts for live load and larger classes", func(t *testing.T) {
		demand := Demand{LiveSlots: 6, Bookings: []Booking{
			book(-15, 0, 20), book(-5, 11, 5), book(7, 11, 3), book(11, 19, 8), book(25, 70, 20),
		}}
		if got := PlanWindow(demand, capacity, now, 25*time.Minute); got != (Plan{4, 2, 2}) {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("exposes unmet demand at the provider cap", func(t *testing.T) {
		if got := PlanWindow(Demand{LiveSlots: 40}, capacity, now, 25*time.Minute); got != (Plan{0, 9, 5}) {
			t.Fatalf("got %+v", got)
		}
	})
}
