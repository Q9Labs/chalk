package mediaplane

import (
	"errors"
	"strconv"
)

// UpstreamError is implemented by provider errors that keep what the provider
// answered. The API may map such an error to a different public status, so logs
// read the provider's own status and code from here.
type UpstreamError interface {
	error
	UpstreamStatus() int
	UpstreamCode() string
}

// UpstreamFailure is the provider's HTTP status and error code for one refused call.
type UpstreamFailure struct {
	Status int
	Code   string
}

func (e UpstreamFailure) Error() string {
	return "upstream status " + strconv.Itoa(e.Status) + " " + e.Code
}

func (e UpstreamFailure) UpstreamStatus() int  { return e.Status }
func (e UpstreamFailure) UpstreamCode() string { return e.Code }

// UpstreamOf returns the provider status and code carried by err, if any.
func UpstreamOf(err error) (UpstreamError, bool) {
	var upstream UpstreamError
	if errors.As(err, &upstream) {
		return upstream, true
	}
	return nil, false
}
