package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func mountMeRoutes(r chi.Router, service AuthenticationService, limits RateLimitOptions) {
	r.With(requireAuthentication(service), rateLimit(limits, authMeRateLimit)).Get("/me", handleMe)
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	sessionUser, ok := sessionUserFromContext(r.Context())
	if !ok {
		writeUnauthenticated(w)
		return
	}

	writeJSON(w, http.StatusOK, newAuthUserResponse(sessionUser.User))
}
