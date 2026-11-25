package media

import (
	"errors"
	"fmt"
	"log/slog"
	"net"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// listenTCPMux opens every configured ICE-TCP listener. With more than one listener, one
// unavailable address is loud but not fatal: TCP 443 must not take down the existing TCP 50000
// path on a node whose kernel setting has not converged yet.
func listenTCPMux(addresses []string, log *slog.Logger) (ice.TCPMux, error) {
	muxes := make([]ice.TCPMux, 0, len(addresses))
	var bindErrors []error
	for _, address := range addresses {
		listener, err := net.Listen("tcp4", address)
		if err != nil {
			bindErrors = append(bindErrors, fmt.Errorf("listen on TCP %q: %w", address, err))
			if len(addresses) > 1 {
				log.Error("ICE-TCP listener unavailable; continuing with the listeners that bound", "address", address, "error", err)
			}
			continue
		}
		muxes = append(muxes, webrtc.NewICETCPMux(nil, listener, iceTCPReadBuffer))
	}
	if len(muxes) == 0 {
		if len(bindErrors) == 0 {
			return nil, nil
		}
		return nil, errors.Join(bindErrors...)
	}
	if len(muxes) < len(addresses) {
		log.Error("ICE-TCP is running with fewer listeners than configured", "bound", len(muxes), "configured", len(addresses))
	}
	if len(muxes) == 1 {
		return muxes[0], nil
	}
	mux := ice.NewMultiTCPMuxDefault(muxes...)
	if len(bindErrors) == 0 {
		return mux, nil
	}
	return mux, nil
}
