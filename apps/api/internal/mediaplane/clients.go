package mediaplane

import (
	"errors"
	"strings"
)

// ErrClientUnsupported means the caller's SDK cannot run the Episode's media
// provider. The Episode keeps its provider: the caller needs a newer SDK.
var ErrClientUnsupported = errors.New("the caller's SDK cannot run the Episode's media provider")

// ClientProviders is the set of media providers that a caller's SDK can run.
// Every released SDK runs Cloudflare, so a caller that declares nothing gets
// Cloudflare only. The Chalk SFU needs an SDK that declares chalk_sfu.
type ClientProviders struct {
	chalk   bool
	assumed bool
}

// ParseClientProviders reads a comma-separated list of provider names. Names
// it does not know are ignored, so a newer SDK can declare a later provider.
func ParseClientProviders(list string) ClientProviders {
	var clients ClientProviders
	for name := range strings.SplitSeq(list, ",") {
		if Provider(strings.TrimSpace(name)) == ProviderChalkSFU {
			clients.chalk = true
		}
	}
	return clients
}

// AllClientProviders is for a request with no SDK of its own to ask, such as a
// host approving a guest. The guest's SDK is checked when the guest collects access.
func AllClientProviders() ClientProviders {
	return ClientProviders{chalk: true, assumed: true}
}

// DeclarationKnown distinguishes a client's declaration (including an absent
// header) from server-assumed support on requests made on the client's behalf.
func (c ClientProviders) DeclarationKnown() bool {
	return !c.assumed
}

// Runs reports whether the caller's SDK can run the provider.
func (c ClientProviders) Runs(provider Provider) bool {
	switch provider {
	case ProviderCloudflareSFU:
		return true
	case ProviderChalkSFU:
		return c.chalk
	default:
		return false
	}
}
