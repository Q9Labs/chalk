package httpapi

import (
	"net/http"
	"strings"
	"time"
)

// The starter cookie outlives the starter's arrival: a Leave clears the guest cookie, but a rejoin is a new arrival and
// still has to show who started the call. It is named by the arrival that started it and lasts as long as the call can.
const (
	publicStarterCookiePrefix = "__Host-chalk_space_starter_"
	maxStarterCookies         = 16
)

func setGuestCookie(w http.ResponseWriter, arrivalHandle, credential string) {
	if arrivalHandle == "" || credential == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: publicGuestCookiePrefix + arrivalHandle, Value: credential, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode})
}

// setCreatorCookies gives the browser that started a call its guest cookie and its starter cookie.
func setCreatorCookies(w http.ResponseWriter, arrivalHandle, credential string, until time.Time) {
	setGuestCookie(w, arrivalHandle, credential)
	maxAge := int(time.Until(until).Seconds())
	if arrivalHandle == "" || credential == "" || maxAge <= 0 {
		return
	}
	http.SetCookie(w, &http.Cookie{Name: publicStarterCookiePrefix + arrivalHandle, Value: credential, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}

// starterCredentialsFromRequest returns the starter credentials a browser holds, by the arrival handle that started each call.
func starterCredentialsFromRequest(r *http.Request) map[string]string {
	if isNativePublicRequest(r) {
		return nil
	}
	starters := map[string]string{}
	for _, cookie := range requestCredentialCookies(r) {
		handle, ok := strings.CutPrefix(cookie.Name, publicStarterCookiePrefix)
		if ok && len(starters) < maxStarterCookies {
			starters[handle] = strings.TrimSpace(cookie.Value)
		}
	}
	return starters
}
