package main

import (
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func parseSwitchRequest(tenant, space, plane string, dryRun bool, state, operator, reason string) (request, error) {
	if tenant != "" || space != "" || plane != "" || dryRun {
		return request{}, errors.New("new-episodes takes only --state, --operator and --reason")
	}
	r := request{command: "new-episodes"}
	switch state {
	case "":
		if operator != "" || reason != "" {
			return request{}, errors.New("--operator and --reason apply to --state")
		}
		return r, nil
	case "on":
	case "off":
		r.paused = true
	default:
		return request{}, errors.New("--state must be on or off")
	}
	origin, err := parseOrigin(operator, reason)
	if err != nil {
		return request{}, err
	}
	r.flip, r.origin = true, origin
	return r, nil
}

// parseTarget reads the Tenant, and the Space when one is named.
func (r *request) parseTarget(tenantText, spaceText string) (err error) {
	if r.tenant, err = utilities.ParseID(tenantText); err != nil {
		return errors.New("--tenant must be a Tenant ID")
	}
	if spaceText != "" {
		if r.space, err = utilities.ParseID(spaceText); err != nil {
			return errors.New("--space must be a Space ID")
		}
	}
	return nil
}
