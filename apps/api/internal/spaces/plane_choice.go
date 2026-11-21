package spaces

import (
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type PlaneChoice struct {
	Plane mediaplane.Provider
	By    mediaplane.Selector
}

// Refusal is the guard that holds a new Episode on Cloudflare although the settings
// chose the Chalk SFU: the kill switch first, then the allowlist. It is empty when
// neither applies. The resolver and Effective both ask it, so they cannot disagree.
func Refusal(paused bool, allowed ChalkSFUAllowlist, spaceID utilities.ID) mediaplane.Selector {
	switch {
	case paused:
		return mediaplane.SelectedByKillSwitch
	case !allowed.Allows(spaceID):
		return mediaplane.SelectedByAllowlist
	}
	return ""
}
