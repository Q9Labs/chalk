package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

// withOrigin tells the code under ctx who is changing a plane and why, under a trace ID
// of its own. A command that changes no plane has no origin and leaves ctx as it is.
func (r *request) withOrigin(ctx context.Context) (context.Context, error) {
	if r.origin.Actor == "" {
		return ctx, nil
	}
	var err error
	if r.origin.TraceID, err = newTraceID(); err != nil {
		return ctx, err
	}
	return mediaplane.WithChangeOrigin(ctx, r.origin), nil
}

// newTraceID names this run, so the change rows it writes and the event the API announces
// for them share one trace ID that an operator can search for.
func newTraceID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", fmt.Errorf("make a trace ID: %w", err)
	}
	return hex.EncodeToString(id[:]), nil
}

func parseOrigin(operator, reason string) (mediaplane.ChangeOrigin, error) {
	origin := mediaplane.ChangeOrigin{Actor: strings.TrimSpace(operator), Reason: strings.TrimSpace(reason)}
	if origin.Actor == "" || origin.Reason == "" {
		return mediaplane.ChangeOrigin{}, errors.New("a change needs --operator and --reason")
	}
	return origin, nil
}

// changeMessage says whether the write changed anything. A write of the value a setting
// already has leaves no audit row.
func changeMessage(change spaces.PlaneChange) string {
	if valueOrInherit(change.Before) == valueOrInherit(change.After) {
		return "media plane setting unchanged: no audit row"
	}
	return "media plane setting changed"
}

// parsePlane reads --plane of set: nil for inherit.
func parsePlane(text string) (*mediaplane.Provider, error) {
	switch text {
	case "inherit":
		return nil, nil
	case "":
		return nil, errors.New("set needs --plane cf_sfu, chalk_sfu or inherit")
	}
	plane, err := mediaplane.ParseSettingName(text)
	if err != nil {
		return nil, errors.New("--plane must be cf_sfu, chalk_sfu or inherit")
	}
	return &plane, nil
}
