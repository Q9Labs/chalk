package main

import (
	"context"
	"errors"
	"fmt"
	"net"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

func sourceVerificationOutcome(ctx context.Context, resources commandResources, keys []string) string {
	available, err := inspectSources(ctx, resources.store, keys)
	if err != nil {
		return "unverifiable"
	}
	if !available {
		return "missing_source"
	}
	return ""
}

func inspectSources(ctx context.Context, store interface {
	InspectObject(context.Context, string) (objectstorage.ObjectFacts, error)
}, keys []string) (bool, error) {
	if len(keys) == 0 {
		return false, nil
	}
	for _, key := range keys {
		facts, err := store.InspectObject(ctx, key)
		if errors.Is(err, objectstorage.ErrObjectNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if facts.Size <= 0 {
			return false, nil
		}
	}
	return true, nil
}

// Driver messages can include credentials or customer SQL. Keep only a bounded category.
func databaseFailure(stage string, err error) error {
	category := "database_error"
	var state interface{ SQLState() string }
	var network net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		category = "timeout"
	case errors.Is(err, context.Canceled):
		category = "canceled"
	case errors.As(err, &state):
		code := state.SQLState()
		valid := len(code) == 5
		for _, c := range code {
			valid = valid && ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'))
		}
		if valid {
			category = "sqlstate_" + code
		}
	case errors.As(err, &network):
		category = "connection_failed"
	}
	return fmt.Errorf("%s (%s)", stage, category)
}
