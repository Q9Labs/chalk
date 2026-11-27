package episodes

import "errors"

var ErrIdentityKindConflict = errors.New("episode participant identity kind conflicts with the registered identity")

type AdmissionMode string

type IdentityKind string

const (
	AdmissionPolicy AdmissionMode = "policy"
	AdmissionDirect AdmissionMode = "direct"

	IdentityKindUser  IdentityKind = "user"
	IdentityKindAgent IdentityKind = "agent"
)
