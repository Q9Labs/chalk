package spaces

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// ChalkSFUAllowlist names the Spaces that may use the own SFU. The zero value
// allows none, so a deployment that turns the own SFU on still keeps every other
// Space on Cloudflare. The entry "*" allows every Space and is meant for staging.
type ChalkSFUAllowlist struct {
	all    bool
	spaces map[utilities.ID]struct{}
}

// ParseChalkSFUAllowlist reads Space IDs, or "*" for every Space.
func ParseChalkSFUAllowlist(entries []string) (ChalkSFUAllowlist, error) {
	list := ChalkSFUAllowlist{spaces: make(map[utilities.ID]struct{}, len(entries))}
	for _, entry := range entries {
		if entry == "*" {
			list.all = true
			continue
		}
		id, err := utilities.ParseID(entry)
		if err != nil {
			return ChalkSFUAllowlist{}, fmt.Errorf("allowlist entry %q is not a Space ID or *", entry)
		}
		list.spaces[id] = struct{}{}
	}
	return list, nil
}

// Allows reports whether the Space may start Episodes on the own SFU.
func (a ChalkSFUAllowlist) Allows(spaceID utilities.ID) bool {
	if a.all {
		return true
	}
	_, ok := a.spaces[spaceID]
	return ok
}

// Size is the number of Spaces named, or -1 when every Space is allowed.
func (a ChalkSFUAllowlist) Size() int {
	if a.all {
		return -1
	}
	return len(a.spaces)
}
