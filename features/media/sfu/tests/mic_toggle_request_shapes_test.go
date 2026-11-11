package tests

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// TestMicToggleRequestShapes runs the relevant off/on request shapes through the real
// control handlers. The malformed-offer case reproduces the paired 400 validation responses,
// but the captured Android request bodies are unavailable, so it is only a candidate shape.
func TestMicToggleRequestShapes(t *testing.T) {
	t.Run("fresh_mid_toggle_and_close_variants", func(t *testing.T) {
		svc := startService(t, newAuthority(t, "mic-toggle test CA"))
		scope := scopeIn("mic-toggle", "alice", 1)
		svc.grantSources(t, scope)
		connectionID := svc.createSession(t, op(), scope)
		peer := newPeer(t)

		_, firstTransceiver, firstOffer := addMicSection(t, peer, "microphone-first")
		firstName := "microphone-first"
		firstMID := firstTransceiver.Mid()
		publishResponse := pushMic(t, svc, connectionID, scope, firstMID, firstName, firstOffer)
		applyAnswer(t, peer, publishResponse)

		// Android's BUNDLE-tag user-pause path sends a forced close by MID without SDP.
		detachTrack(t, firstTransceiver)
		status, closeResponse := postControl(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: scope, Tracks: []protocol.CloseTrack{{Mid: firstMID}}, Force: true,
		})
		if status != http.StatusOK || len(closeResponse.Tracks) != 1 || closeResponse.Tracks[0].AlreadyClosed {
			t.Fatalf("first forced close: status=%d response=%+v", status, closeResponse)
		}

		// Reusing a retired MID is not an HTTP 400: it is a per-track invalid_track response.
		retryTrack := newMicTrack(t, "microphone-same-mid")
		if err := firstTransceiver.Sender().ReplaceTrack(retryTrack); err != nil {
			t.Fatal(err)
		}
		retryOffer := makeOffer(t, peer)
		retryResponse := pushMic(t, svc, connectionID, scope, firstMID, "microphone-retry-name", retryOffer)
		if len(retryResponse.TrackErrors) != 1 || retryResponse.TrackErrors[0].Code != protocol.TrackCodeInvalid || retryResponse.TrackErrors[0].Message != "mid was closed; publish on a new section" {
			t.Fatalf("same-MID republish response: %+v", retryResponse)
		}
		applyAnswer(t, peer, retryResponse)

		// A fresh MID works, and reusing the now-closed trackName on that fresh MID also works.
		detachAndStop(t, firstTransceiver)
		_, secondTransceiver, secondOffer := addMicSection(t, peer, "microphone-second")
		secondMID := secondTransceiver.Mid()
		secondName := "microphone-second"
		if secondMID == firstMID {
			t.Fatalf("new transceiver reused MID %q", secondMID)
		}
		secondResponse := pushMic(t, svc, connectionID, scope, secondMID, secondName, secondOffer)
		if len(secondResponse.TrackErrors) != 0 || secondResponse.SessionDescription == nil {
			t.Fatalf("fresh-MID republish response: %+v", secondResponse)
		}
		applyAnswer(t, peer, secondResponse)

		detachAndStop(t, secondTransceiver)
		status, closeResponse = postControl(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: scope, Tracks: []protocol.CloseTrack{{Mid: secondMID}}, Force: true,
		})
		if status != http.StatusOK || closeResponse.Tracks[0].AlreadyClosed {
			t.Fatalf("second forced close: status=%d response=%+v", status, closeResponse)
		}

		_, reusedNameTransceiver, reusedNameOffer := addMicSection(t, peer, "microphone-trackname-reuse")
		reusedNameResponse := pushMic(t, svc, connectionID, scope, reusedNameTransceiver.Mid(), secondName, reusedNameOffer)
		if len(reusedNameResponse.TrackErrors) != 0 || reusedNameResponse.SessionDescription == nil {
			t.Fatalf("fresh-MID same-trackName response: %+v", reusedNameResponse)
		}
		applyAnswer(t, peer, reusedNameResponse)

		// A stale/already-closed MID is idempotent on the forced-close path.
		status, closeResponse = postControl(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: scope, Tracks: []protocol.CloseTrack{{Mid: firstMID}}, Force: true,
		})
		if status != http.StatusOK || len(closeResponse.Tracks) != 1 || !closeResponse.Tracks[0].AlreadyClosed {
			t.Fatalf("stale forced close: status=%d response=%+v", status, closeResponse)
		}

		// Force=false is valid when the client supplies the offer after stopping the transceiver.
		detachAndStop(t, reusedNameTransceiver)
		negotiatedCloseOffer := makeOffer(t, peer)
		status, closeResponse = postControl(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: scope, Tracks: []protocol.CloseTrack{{Mid: reusedNameTransceiver.Mid()}},
			SessionDescription: &negotiatedCloseOffer,
		})
		if status != http.StatusOK || closeResponse.SessionDescription == nil {
			t.Fatalf("negotiated close: status=%d response=%+v", status, closeResponse)
		}
		applyCloseAnswer(t, peer, closeResponse)

		// The request-level force/SDP combinations are strict and return HTTP 400.
		assertProblem(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: scope, Tracks: []protocol.CloseTrack{{Mid: firstMID}}, Force: true,
			SessionDescription: &negotiatedCloseOffer,
		}, "invalid request: a forced close carries no SDP")
		assertProblem(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: scope, Tracks: []protocol.CloseTrack{{Mid: firstMID}}, Force: false,
		}, "invalid request: a negotiated close needs the client's offer")
		assertProblem(t, svc, "/v1/sessions/"+connectionID+"/tracks", protocol.TracksRequest{
			OperationID: op(), Scope: scope,
			Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: firstMID, TrackName: firstName, Source: "microphone"}},
		}, "invalid request: a push needs an offer")

		// The internal close contract is MID-only; trackName-only JSON is rejected at decode.
		trackNameClose, err := json.Marshal(map[string]any{
			"operationId": op(), "scope": scope, "force": true,
			"tracks": []map[string]string{{"trackName": firstName}},
		})
		if err != nil {
			t.Fatal(err)
		}
		assertRawProblem(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", trackNameClose,
			"invalid request\njson: unknown field \"trackName\"")
	})

	t.Run("unmatched_offer_section_produces_the_paired_400s", func(t *testing.T) {
		svc := startService(t, newAuthority(t, "unmatched offer test CA"))
		scope := scopeIn("unmatched-offer", "alice", 1)
		svc.grantSources(t, scope)
		connectionID := svc.createSession(t, op(), scope)
		peer := newPeer(t)

		// The offer contains two new MIDs, but the request names only the microphone MID.
		micTransceiver := addMicTransceiver(t, peer, "microphone-named")
		_ = addMicTransceiver(t, peer, "microphone-unlisted")
		offer := makeOffer(t, peer)
		mid := micTransceiver.Mid()
		assertProblem(t, svc, "/v1/sessions/"+connectionID+"/tracks", protocol.TracksRequest{
			OperationID: op(), Scope: scope, SessionDescription: &offer,
			Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: mid, TrackName: "microphone-named", Source: "microphone"}},
		}, "invalid request: the offer has a section that no track of the request names")

		// A hypothetical negotiated cleanup close carrying the same unregistered section
		// is rejected too. This is a handler-level candidate, not a proven SDK follow-up:
		// the shipped client has no publication handle when a create request itself fails.
		assertProblem(t, svc, "/v1/sessions/"+connectionID+"/tracks/close", protocol.CloseTracksRequest{
			OperationID: op(), Scope: scope, Tracks: []protocol.CloseTrack{{Mid: mid}},
			SessionDescription: &offer,
		}, "invalid request: a close offer cannot add a section")
	})

	t.Run("active_trackName_reuse_is_a_per_track_error", func(t *testing.T) {
		svc := startService(t, newAuthority(t, "duplicate trackName test CA"))
		scope := scopeIn("duplicate-trackname", "alice", 1)
		svc.grantSources(t, scope)
		connectionID := svc.createSession(t, op(), scope)
		peer := newPeer(t)

		_, firstTransceiver, firstOffer := addMicSection(t, peer, "microphone-active")
		firstName := "microphone-active"
		firstResponse := pushMic(t, svc, connectionID, scope, firstTransceiver.Mid(), firstName, firstOffer)
		applyAnswer(t, peer, firstResponse)

		_, secondTransceiver, secondOffer := addMicSection(t, peer, "microphone-duplicate-name")
		secondResponse := pushMic(t, svc, connectionID, scope, secondTransceiver.Mid(), firstName, secondOffer)
		if len(secondResponse.TrackErrors) != 1 || secondResponse.TrackErrors[0].Code != protocol.TrackCodeDuplicate || secondResponse.TrackErrors[0].Message != "mid or track name is already published" {
			t.Fatalf("active trackName reuse response: %+v", secondResponse)
		}
		applyAnswer(t, peer, secondResponse)
	})
}

func newMicTrack(t *testing.T, id string) *webrtc.TrackLocalStaticRTP {
	t.Helper()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, id, "alice")
	if err != nil {
		t.Fatal(err)
	}
	return track
}

func addMicSection(t *testing.T, peer *peer, id string) (*webrtc.TrackLocalStaticRTP, *webrtc.RTPTransceiver, protocol.SessionDescription) {
	t.Helper()
	track := newMicTrack(t, id)
	transceiver := addMicTransceiverWithTrack(t, peer, track)
	return track, transceiver, makeOffer(t, peer)
}

func addMicTransceiver(t *testing.T, peer *peer, id string) *webrtc.RTPTransceiver {
	t.Helper()
	track := newMicTrack(t, id)
	return addMicTransceiverWithTrack(t, peer, track)
}

func addMicTransceiverWithTrack(t *testing.T, peer *peer, track *webrtc.TrackLocalStaticRTP) *webrtc.RTPTransceiver {
	t.Helper()
	transceiver, err := peer.pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	return transceiver
}

func makeOffer(t *testing.T, peer *peer) protocol.SessionDescription {
	t.Helper()
	offer, err := peer.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	return peer.complete(t, offer)
}

func pushMic(t *testing.T, svc *service, connectionID string, scope protocol.Scope, mid, name string, offer protocol.SessionDescription) protocol.TracksResponse {
	t.Helper()
	encoded, err := json.Marshal(protocol.TracksRequest{
		OperationID: op(), Scope: scope, SessionDescription: &offer,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: mid, TrackName: name, Source: "microphone"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	status, raw := postRaw(t, svc, "/v1/sessions/"+connectionID+"/tracks", encoded)
	if status != http.StatusOK {
		t.Fatalf("push status=%d", status)
	}
	var response protocol.TracksResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode push response: %v (%s)", err, raw)
	}
	return response
}

func postControl(t *testing.T, svc *service, path string, body any) (int, protocol.CloseTracksResponse) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	status, raw := postRaw(t, svc, path, encoded)
	var response protocol.CloseTracksResponse
	if status < 300 && len(raw) > 0 {
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Fatalf("decode %s response: %v (%s)", path, err, raw)
		}
	}
	return status, response
}

func postRaw(t *testing.T, svc *service, path string, body []byte) (int, []byte) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, svc.baseURL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := svc.client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, raw
}

func assertProblem(t *testing.T, svc *service, path string, body any, message string) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	assertRawProblem(t, svc, path, encoded, message)
}

func assertRawProblem(t *testing.T, svc *service, path string, body []byte, message string) {
	t.Helper()
	status, raw := postRaw(t, svc, path, body)
	var response protocol.ErrorResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode %s error response: %v (%s)", path, err, raw)
	}
	if status != http.StatusBadRequest || response.Error.Code != protocol.CodeInvalidRequest || response.Error.Message != message {
		t.Fatalf("POST %s: status=%d code=%q message=%q; want 400 invalid_request %q", path, status, response.Error.Code, response.Error.Message, message)
	}
}

func applyAnswer(t *testing.T, peer *peer, response protocol.TracksResponse) {
	t.Helper()
	if response.SessionDescription == nil {
		t.Fatal("push response has no answer")
	}
	if err := peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
}

func applyCloseAnswer(t *testing.T, peer *peer, response protocol.CloseTracksResponse) {
	t.Helper()
	if response.SessionDescription == nil {
		t.Fatal("negotiated close response has no answer")
	}
	if err := peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
}

func detachTrack(t *testing.T, transceiver *webrtc.RTPTransceiver) {
	t.Helper()
	if err := transceiver.Sender().ReplaceTrack(nil); err != nil {
		t.Fatal(err)
	}
}

func detachAndStop(t *testing.T, transceiver *webrtc.RTPTransceiver) {
	t.Helper()
	detachTrack(t, transceiver)
	if err := transceiver.Stop(); err != nil {
		t.Fatal(err)
	}
}
