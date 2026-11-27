package office

import "strings"

const (
	CodePasswordProtected = "password_protected"
	CodeCorrupt           = "corrupt"
	CodeTooManyPages      = "too_many_pages"
	CodeTooLarge          = "too_large"
	CodeUnsupportedFormat = "unsupported_format"
)

const (
	MaxPages        = 300
	ExportPageLimit = MaxPages + 1
	MaxPDFBytes     = 64 << 20
	failurePrefix   = "office_failure="
	precheckMarker  = "precheck: "
)

type Failure struct {
	Code    string
	Message string
	// Precheck marks a failure found by reading the document's container, before any parser touches it.
	Precheck bool
}

func (f *Failure) Error() string {
	if f.Precheck {
		return failurePrefix + f.Code + ": " + precheckMarker + f.Message
	}
	return failurePrefix + f.Code + ": " + f.Message
}

// IsPrecheckFailure reports whether a child's failure message names a rejection made before any parser ran.
func IsPrecheckFailure(message string) bool {
	_, rest, found := strings.Cut(message, failurePrefix)
	if !found {
		return false
	}
	_, detail, _ := strings.Cut(rest, ": ")
	return strings.HasPrefix(detail, precheckMarker)
}

func CodeFromMessage(message string) (string, bool) {
	_, rest, found := strings.Cut(message, failurePrefix)
	if !found {
		return "", false
	}
	code, _, _ := strings.Cut(rest, ":")
	switch code {
	case CodePasswordProtected, CodeCorrupt, CodeTooManyPages, CodeTooLarge, CodeUnsupportedFormat:
		return code, true
	}
	return "", false
}

func TooManyPagesMessage() string {
	return "document has more than 300 pages; only the first 300 are allowed"
}
