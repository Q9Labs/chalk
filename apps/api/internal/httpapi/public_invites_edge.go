package httpapi

import (
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func isNativePublicRequest(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get(publicClientHeader)), "react-native")
}

func guestCredentialFromRequest(r *http.Request, arrivalHandle string) string {
	if isNativePublicRequest(r) {
		scheme, credential, ok := authorizationCredential(r.Header.Get("Authorization"))
		if !ok || !strings.EqualFold(scheme, publicGuestScheme) {
			return ""
		}
		return strings.TrimSpace(credential)
	}
	if arrivalHandle == "" {
		return ""
	}
	for _, cookie := range requestCredentialCookies(r) {
		if cookie.Name == publicGuestCookiePrefix+arrivalHandle {
			return strings.TrimSpace(cookie.Value)
		}
	}
	return ""
}

func rejectNativePublicCookies(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isNativePublicRequest(r) && strings.TrimSpace(r.Header.Get("Cookie")) != "" {
			writeAPIError(w, apiErrorForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requirePublicOrigin(origins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		if value := strings.TrimSpace(origin); value != "" && value != "*" {
			allowed[value] = struct{}{}
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isNativePublicRequest(r) {
				if r.Header.Get("Cookie") != "" {
					writeAPIError(w, apiErrorForbidden)
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind != authentication.PrincipalUser {
				next.ServeHTTP(w, r)
				return
			}
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin == "" {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			if _, ok := allowed[origin]; !ok {
				writeAPIError(w, apiErrorForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func noStoreResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func writePublicSpaceCreated(w http.ResponseWriter, r *http.Request, status int, response publicSpaceCreatedResponse) {
	if isNativePublicRequest(r) {
		writeJSON(w, status, response)
		return
	}
	credential := response.GuestCredential
	if credential == "" {
		credential = response.Arrival.GuestCredential
	}
	setGuestCookie(w, response.Arrival.ArrivalHandle, credential)
	response.GuestCredential = ""
	response.Arrival.GuestCredential = ""
	writeJSON(w, status, response)
}

func writePublicArrival(w http.ResponseWriter, r *http.Request, status int, response publicSpaceArrivalResponse) {
	if isNativePublicRequest(r) {
		writeJSON(w, status, response)
		return
	}
	setGuestCookie(w, response.ArrivalHandle, response.GuestCredential)
	response.GuestCredential = ""
	writeJSON(w, status, response)
}

func writePublicLeave(w http.ResponseWriter, r *http.Request, status int, _ struct{}) {
	if !isNativePublicRequest(r) {
		if arrivalHandle := strings.TrimSpace(r.Header.Get(publicInviteTokenHeader)); arrivalHandle != "" {
			http.SetCookie(w, &http.Cookie{Name: publicGuestCookiePrefix + arrivalHandle, Value: "", Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		}
	}
	w.WriteHeader(status)
}

func setGuestCookie(w http.ResponseWriter, arrivalHandle, credential string) {
	if arrivalHandle == "" || credential == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: publicGuestCookiePrefix + arrivalHandle, Value: credential, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
}
