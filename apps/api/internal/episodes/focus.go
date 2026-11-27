package episodes

import (
	"context"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type FocusInterval struct {
	State     string
	Windowed  bool
	StartedAt time.Time
	EndedAt   time.Time
}

type FocusStepAway struct {
	Reason    string
	StartedAt time.Time
	EndedAt   *time.Time
}

type FocusAllowWindow struct {
	ActorParticipantID utilities.ID
	StartedAt          time.Time
	EndsAt             time.Time
	EndedAt            *time.Time
}

type FocusParticipant struct {
	ParticipantID   utilities.ID
	DisplayName     string
	Intervals       []FocusInterval
	StepAways       []FocusStepAway
	EpisodeStartsAt time.Time
	EpisodeEndsAt   time.Time
}

type FocusArtifact struct {
	EpisodeID    utilities.ID
	Participants []FocusParticipant
	AllowWindows []FocusAllowWindow
}

func (s Service) GetEpisodeFocus(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) (FocusArtifact, error) {
	if err := validateTenantSpaceEpisodeIDs(tenantID, spaceID, episodeID); err != nil {
		return FocusArtifact{}, err
	}
	return s.repository.GetEpisodeFocus(ctx, tenantID, spaceID, episodeID)
}

func EffectiveFocusWindow(window FocusAllowWindow, fallback time.Time) (time.Time, time.Time) {
	end := window.EndsAt
	if window.EndedAt != nil && window.EndedAt.Before(end) {
		end = *window.EndedAt
	}
	if end.After(fallback) {
		end = fallback
	}
	return window.StartedAt, end
}

func FocusAwayIntervals(intervals []FocusInterval, allowances []FocusAllowWindow, episodeEnd time.Time) []FocusInterval {
	away := make([]FocusInterval, 0, len(intervals))
	for _, interval := range intervals {
		if interval.State == "active" {
			continue
		}
		pieces := []FocusInterval{interval}
		for _, allowance := range allowances {
			start, end := EffectiveFocusWindow(allowance, episodeEnd)
			pieces = subtractFocusWindow(pieces, start, end)
		}
		away = append(away, pieces...)
	}
	sort.Slice(away, func(i, j int) bool { return away[i].StartedAt.Before(away[j].StartedAt) })
	return mergeFocusIntervals(away)
}

func subtractFocusWindow(pieces []FocusInterval, start, end time.Time) []FocusInterval {
	var next []FocusInterval
	for _, piece := range pieces {
		if end.Before(piece.StartedAt) || start.After(piece.EndedAt) || end.Equal(piece.StartedAt) || start.Equal(piece.EndedAt) {
			next = append(next, piece)
			continue
		}
		if start.After(piece.StartedAt) {
			left := piece
			left.EndedAt = start
			next = append(next, left)
		}
		if end.Before(piece.EndedAt) {
			right := piece
			right.StartedAt = end
			next = append(next, right)
		}
	}
	return next
}

func mergeFocusIntervals(sorted []FocusInterval) []FocusInterval {
	merged := make([]FocusInterval, 0, len(sorted))
	for _, interval := range sorted {
		if !interval.EndedAt.After(interval.StartedAt) {
			continue
		}
		if len(merged) > 0 {
			last := &merged[len(merged)-1]
			if !interval.StartedAt.After(last.EndedAt) {
				if interval.EndedAt.After(last.EndedAt) {
					last.EndedAt = interval.EndedAt
				}
				continue
			}
		}
		merged = append(merged, interval)
	}
	return merged
}

func FocusReportedSeconds(intervals []FocusInterval) int64 {
	ranges := append(make([]FocusInterval, 0, len(intervals)), intervals...)
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].StartedAt.Before(ranges[j].StartedAt) })
	var total int64
	var current *FocusInterval
	for _, interval := range ranges {
		if current == nil || interval.StartedAt.After(current.EndedAt) {
			copy := interval
			current = &copy
			total += int64(interval.EndedAt.Sub(interval.StartedAt).Seconds())
			continue
		}
		if interval.EndedAt.After(current.EndedAt) {
			total += int64(interval.EndedAt.Sub(current.EndedAt).Seconds())
			current.EndedAt = interval.EndedAt
		}
	}
	return total
}
