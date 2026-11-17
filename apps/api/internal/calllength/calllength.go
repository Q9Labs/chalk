// Package calllength is the one place that says how long a call lasts: the
// bounds every Space must respect, and the named policies that decide the
// default, the maximum and the linger window for who starts the call.
package calllength

import "time"

const (
	// MinimumSeconds and MaximumSeconds bound every Space duration and linger.
	MinimumSeconds int32 = 60
	MaximumSeconds int32 = 7 * 24 * 60 * 60
)

// Policy is the length policy a Space freezes into each Episode it starts.
// DefaultSeconds sets the first deadline, MaximumSeconds is the ceiling that
// extensions cannot pass, and LingerSeconds keeps an empty Episode open for a
// host who rejoins.
type Policy struct {
	DefaultSeconds int32
	MaximumSeconds int32
	LingerSeconds  int32
}

// Anonymous is the policy of a call started without an account. It cannot be
// extended, and its Space lives exactly as long as its Episode.
var Anonymous = Policy{DefaultSeconds: 3600, MaximumSeconds: 3600, LingerSeconds: 30}

// API is the policy of a Space that its tenant created without choosing one.
var API = Policy{DefaultSeconds: 24 * 60 * 60, MaximumSeconds: 24 * 60 * 60, LingerSeconds: 0}

// MaximumLifetime is how long a call under this policy can last.
func (p Policy) MaximumLifetime() time.Duration {
	return time.Duration(p.MaximumSeconds) * time.Second
}
