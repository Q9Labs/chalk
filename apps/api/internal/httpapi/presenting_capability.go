package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/presenting"
)

const presentingRenderCapabilityHeader = "X-Chalk-Render-Capability"

type PresentingCapabilityAuthorizer interface {
	AuthorizePresentingRenderCapability(*http.Request) (presenting.RenderCapability, error)
}

type HMACPresentingCapabilityAuthorizer struct {
	signer presenting.CapabilitySigner
}

func NewHMACPresentingCapabilityAuthorizer(signer presenting.CapabilitySigner) HMACPresentingCapabilityAuthorizer {
	return HMACPresentingCapabilityAuthorizer{signer: signer}
}

func (a HMACPresentingCapabilityAuthorizer) AuthorizePresentingRenderCapability(request *http.Request) (presenting.RenderCapability, error) {
	value := strings.TrimSpace(request.Header.Get(presentingRenderCapabilityHeader))
	if value == "" {
		return presenting.RenderCapability{}, presenting.ErrRenderCapabilityInvalid
	}
	return a.signer.Verify(value)
}

func writePresentingCapabilityUnauthorized(w http.ResponseWriter, err error) {
	if errors.Is(err, presenting.ErrRenderCapabilityExpired) {
		writeError(w, http.StatusUnauthorized, "presenting.capability_expired", "Render capability expired")
		return
	}
	writeError(w, http.StatusUnauthorized, "presenting.capability_invalid", "Render capability is invalid")
}
