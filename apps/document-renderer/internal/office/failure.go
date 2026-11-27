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
)

type Failure struct {
	Code    string
	Message string
}

func (f *Failure) Error() string { return failurePrefix + f.Code + ": " + f.Message }

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
