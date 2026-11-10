package mediaplane

import (
	"context"
	"errors"
	"testing"
)

type updatingPlane struct{ Plane }

func (updatingPlane) UpdateTracks(context.Context, UpdateTracksRequest) (TracksResponse, error) {
	return TracksResponse{}, nil
}

type holdingPlane struct{ updatingPlane }

func (holdingPlane) HoldsPublications() {}

func TestLocalUpdateNeedsAPlaneThatHoldsPublications(t *testing.T) {
	paused := true
	local := Track{Location: "local", Mid: "1", TrackName: "cam", Source: "camera", Paused: &paused}
	request := func() UpdateTracksRequest {
		return UpdateTracksRequest{ConnectionID: "conn", Tracks: []Track{local}}
	}
	if _, err := NewService(updatingPlane{}).UpdateTracks(context.Background(), request()); !errors.Is(err, ErrUnsupportedOperation) {
		t.Fatalf("a plane that cannot hold publications: %v", err)
	}
	if _, err := NewService(holdingPlane{}).UpdateTracks(context.Background(), request()); err != nil {
		t.Fatalf("a plane that holds publications: %v", err)
	}
}

func TestLocalUpdateIsValidated(t *testing.T) {
	paused := true
	valid := Track{Location: "local", Mid: "1", TrackName: "cam", Source: "camera", Paused: &paused}
	for name, change := range map[string]func(*Track){
		"no pause state": func(track *Track) { track.Paused = nil },
		"no mid":         func(track *Track) { track.Mid = "" },
		"no source":      func(track *Track) { track.Source = "" },
		"unknown source": func(track *Track) { track.Source = "sound" },
		"a session":      func(track *Track) { track.SessionID = "other" },
		"a layer policy": func(track *Track) {
			track.Simulcast = &Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}
		},
	} {
		track := valid
		change(&track)
		if _, err := NewService(holdingPlane{}).UpdateTracks(context.Background(), UpdateTracksRequest{ConnectionID: "conn", Tracks: []Track{track}}); !errors.Is(err, ErrInvalidSignalRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
