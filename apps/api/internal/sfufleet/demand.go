// Package sfufleet plans and reconciles scheduled Chalk SFU capacity.
package sfufleet

import (
	"cmp"
	"slices"
	"time"
)

type Booking struct {
	StartsAt     time.Time
	EndsAt       time.Time
	Participants int
	CoveredSlots int
}

type Demand struct {
	Bookings  []Booking
	LiveSlots int
}

type Capacity struct {
	StandingSlots int
	SlotsPerNode  int
	SpareSlots    int
	MaxNodes      int
}

type Plan struct {
	PeakBookedSlots int
	RequiredNodes   int
	TargetNodes     int
}

// PlanWindow targets peak concurrent demand. A pair of adjacent bookings can
// use the same capacity. Live load is held through the full lookahead because
// the expected end of a booking is not a deadline on the running Episode.
func PlanWindow(demand Demand, capacity Capacity, now time.Time, lookahead time.Duration) Plan {
	type edge struct {
		at    time.Time
		delta int
	}
	end := now.Add(lookahead)
	edges := make([]edge, 0, len(demand.Bookings)*2)
	for _, booking := range demand.Bookings {
		if !booking.EndsAt.After(now) || !booking.StartsAt.Before(end) {
			continue
		}
		slots := max(0, ClassSlots(booking.Participants, capacity.SlotsPerNode)-booking.CoveredSlots)
		edges = append(edges, edge{booking.StartsAt, slots}, edge{booking.EndsAt, -slots})
	}
	slices.SortFunc(edges, func(a, b edge) int {
		if byTime := a.at.Compare(b.at); byTime != 0 {
			return byTime
		}
		return cmp.Compare(a.delta, b.delta)
	})
	booked, peak := 0, 0
	for _, edge := range edges {
		booked += edge.delta
		peak = max(peak, booked)
	}
	spare := 0
	if len(edges) > 0 || demand.LiveSlots > capacity.StandingSlots {
		spare = capacity.SpareSlots
	}
	shortfall := max(0, demand.LiveSlots+peak+spare-capacity.StandingSlots)
	required := (shortfall + capacity.SlotsPerNode - 1) / capacity.SlotsPerNode
	return Plan{PeakBookedSlots: peak, RequiredNodes: required, TargetNodes: min(required, capacity.MaxNodes)}
}

// ClassSlots sizes against the SFU's class reservation, which includes a
// screen share. Four to six participants can reserve 11,520 packets/s versus
// 7,170 for three. Larger calls may reserve the entire node.
func ClassSlots(participants, slotsPerNode int) int {
	switch {
	case participants <= 3:
		return 1
	case participants <= 6:
		return 2
	default:
		return slotsPerNode
	}
}
