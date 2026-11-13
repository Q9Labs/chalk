package sfu

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func (a Adapter) providerMetadata() map[string]string {
	return map[string]string{
		"api_base":    fmt.Sprintf("%s/apps/%s", a.endpoint, a.appID),
		"app_id":      a.appID,
		"stun_server": stunServer,
		"sync_owner":  syncOwner,
	}
}

func (a Adapter) joinForConnection(episodeRef string, participantRef string, connectionID string, iceServers []mediaplane.ICEServer) mediaplane.Join {
	return mediaplane.Join{
		Provider:       mediaplane.ProviderCloudflareSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"connectionId": connectionID,
			"provider":     string(mediaplane.ProviderCloudflareSFU),
			"episodeRef":   episodeRef,
			"stunServer":   stunServer,
			"iceServers":   iceServers,
			"syncOwner":    syncOwner,
		},
		Metadata: a.providerMetadata(),
	}
}
