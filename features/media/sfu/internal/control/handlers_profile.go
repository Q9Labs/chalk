package control

import (
	"fmt"
	"net/http"
	"net/http/pprof"
	"net/url"
	"strconv"

	"github.com/q9labs/chalk/features/media/sfu/internal/media"
)

func servePprof(handle http.HandlerFunc) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		handle(w, r)
		return nil
	}
}

// profile samples the CPU for the asked seconds. The standard handler defaults to 30, which the
// request deadline would cut short, so an absent value means the limit and a longer one is refused.
func (s *Server) profile(w http.ResponseWriter, r *http.Request) error {
	query := r.URL.Query()
	seconds, err := profileSeconds(query)
	if err != nil {
		return err
	}
	query.Set("seconds", strconv.Itoa(seconds))
	sampled := r.Clone(r.Context())
	sampled.URL.RawQuery = query.Encode()
	pprof.Profile(w, sampled)
	return nil
}

func profileSeconds(query url.Values) (int, error) {
	raw := query.Get("seconds")
	if raw == "" {
		return maxProfileSeconds, nil
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 1 || seconds > maxProfileSeconds {
		return 0, fmt.Errorf("%w: seconds must be a whole number from 1 to %d", media.ErrInvalidRequest, maxProfileSeconds)
	}
	return seconds, nil
}
