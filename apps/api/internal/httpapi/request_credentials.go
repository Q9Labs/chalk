package httpapi

import (
	"net/http"
	"strings"
)

// authorizationCredential is shared by bearer auth and native guest auth.
func authorizationCredential(header string) (scheme, credential string, ok bool) {
	scheme, credential, ok = strings.Cut(strings.TrimSpace(header), " ")
	credential = strings.TrimSpace(credential)
	return scheme, credential, ok && credential != ""
}

func bearerToken(header string) (string, bool) {
	scheme, credential, ok := authorizationCredential(header)
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	return credential, true
}

// Dashboard auth owns the __Host-chalk_/local_chalk_ namespaces, including
// session, binding, login state and per-Space seats (web/server/cookies.ts).
// Public guest auth owns its dynamic prefix. Do not enumerate individual cookies:
// multiple arrivals, duplicate names and future auth purposes must stay covered.
func requestCredentialCookies(r *http.Request) []*http.Cookie {
	var credentials []*http.Cookie
	for _, cookie := range r.Cookies() {
		if strings.HasPrefix(cookie.Name, publicGuestCookiePrefix) || strings.HasPrefix(cookie.Name, "__Host-chalk_") || strings.HasPrefix(cookie.Name, "local_chalk_") {
			credentials = append(credentials, cookie)
		}
	}
	return credentials
}
