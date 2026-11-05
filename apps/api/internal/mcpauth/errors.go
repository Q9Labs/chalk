package mcpauth

import "errors"

// Error is an RFC 6749 error response.
type Error struct {
	Code        string
	Description string
	Status      int
}

func (e *Error) Error() string { return e.Code + ": " + e.Description }

func oauthError(status int, code, description string) *Error {
	return &Error{Code: code, Description: description, Status: status}
}

var (
	ErrClientNotFound     = errors.New("oauth client not found")
	ErrRequestNotFound    = errors.New("oauth authorization request not found")
	ErrInvalidGrant       = errors.New("oauth grant is invalid, expired or used")
	ErrGrantReused        = errors.New("oauth credential was used twice; grant revoked")
	ErrGrantNotFound      = errors.New("oauth grant not found")
	ErrInvalidAccessToken = errors.New("oauth access token is invalid")
	ErrInvalidApproval    = errors.New("approved scope exceeds the request")
)

// AuthorizeFailure reports a rejected /authorize request. RedirectURI is set
// only when the client and redirect URI were validated, so the error may be
// returned to the client; otherwise the server must show the error itself.
type AuthorizeFailure struct {
	Err         *Error
	RedirectURI string
	State       string
}

func (f *AuthorizeFailure) Error() string { return f.Err.Error() }
