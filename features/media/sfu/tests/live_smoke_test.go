package tests

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// TestLiveSmokeClasses holds three-person classes on a deployed node: two
// cameras each, one sharing a screen, everyone pulling everyone, and
// reports what the node saw. It runs only against a live node:
//
//	SFU_LIVE_URL        the node's control URL, such as an SSH tunnel
//	SFU_LIVE_CA         the service CA
//	SFU_LIVE_CERT, _KEY a client certificate with the API identity
//	SFU_LIVE_CLASSES    classes to hold (default 2)
//	SFU_LIVE_HOLD       how long to hold them (default 5m)
func TestLiveSmokeClasses(t *testing.T) {
	controlURL := os.Getenv("SFU_LIVE_URL")
	if controlURL == "" {
		t.Skip("SFU_LIVE_URL is not set")
	}
	classes, hold := 2, 5*time.Minute
	if value := os.Getenv("SFU_LIVE_CLASSES"); value != "" {
		if _, err := fmt.Sscan(value, &classes); err != nil {
			t.Fatal(err)
		}
	}
	if value := os.Getenv("SFU_LIVE_HOLD"); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil {
			t.Fatal(err)
		}
		hold = parsed
	}
	svc := &service{baseURL: controlURL, client: liveClient(t)}
	// The node keeps operation IDs for idempotency, so each run needs its own.
	operations.Store(time.Now().UnixNano())
	run := time.Now().UnixNano()
	var everyone [][]*participant
	for class := range classes {
		episode := fmt.Sprintf("live-smoke-%d-%d", run, class)
		people := make([]*participant, 3)
		for index := range people {
			through := newLinkOn(t, "0.0.0.0:0")
			p := &participant{name: fmt.Sprintf("c%dp%d", class, index), link: through,
				scope: protocol.Scope{TenantID: "live-smoke", EpisodeID: episode, ParticipantID: fmt.Sprintf("p%d", index), Generation: 1}}
			p.peer = newMediaPeer(t, through, true)
			p.media = receiveMedia(p.peer, false)
			p.conn = svc.createSession(t, op(), p.scope)
			svc.grantSources(t, p.scope)
			p.publish(t, svc, publishing{camera: index < 2, screen: index == 0, chunks: [2]int{1100, 1100}})
			people[index] = p
		}
		for _, person := range people {
			var tracks []protocol.Track
			for index, other := range people {
				if other == person {
					continue
				}
				tracks = append(tracks, remote(other, micName))
				if index < 2 {
					tracks = append(tracks, remote(other, cameraName))
				}
				if index == 0 {
					tracks = append(tracks, remote(other, screenName))
				}
			}
			person.pull(t, svc, tracks)
		}
		everyone = append(everyone, people)
		t.Cleanup(func() {
			_, _ = svc.call(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: "live-smoke", EpisodeID: episode}, nil)
		})
	}
	// The API renews every standing grant every 5 s; without it a source's
	// 15-second lease lapses and the node stops forwarding it.
	renewing, stopRenewing := context.WithCancel(context.Background())
	t.Cleanup(stopRenewing)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-renewing.Done():
				return
			case <-ticker.C:
				for _, people := range everyone {
					for _, person := range people {
						renewGrants(svc, person.scope)
					}
				}
			}
		}
	}()
	screens := 0
	eventually(t, "every viewer receives the screen", 30*time.Second, func() bool {
		screens = 0
		for _, people := range everyone {
			for _, viewer := range people[1:] {
				if viewer.media.videoCount(trackKey(people[0], screenName)) > 0 {
					screens++
				}
			}
		}
		return screens == 2*classes
	})

	type sample struct {
		pps, steal, queueP95 float64
		sessions, drops      int64
	}
	var samples []sample
	started := time.Now()
	for time.Since(started) < hold {
		ready := readyz(t, svc)
		drops := int64(-1)
		if ready.Host.UDPReceiveBufferErrors != nil {
			drops = int64(*ready.Host.UDPReceiveBufferErrors)
		}
		steal := 0.0
		if ready.Host.StealPercent != nil {
			steal = *ready.Host.StealPercent
		}
		samples = append(samples, sample{ready.Host.PacketsPerSecond, steal, ready.Host.QueueDelayP95Ms, int64(ready.Sessions), drops})
		time.Sleep(10 * time.Second)
	}
	var peak, sum, peakSteal, peakQueue float64
	for _, s := range samples {
		sum += s.pps
		peak = max(peak, s.pps)
		peakSteal = max(peakSteal, s.steal)
		peakQueue = max(peakQueue, s.queueP95)
	}
	first, last := samples[0], samples[len(samples)-1]
	t.Logf("%d classes for %v: sessions %d; node packets/s mean %.0f, peak %.0f; steal peak %.2f%%; pacer queue p95 peak %.1f ms; receive-buffer drops %d -> %d",
		classes, hold, last.sessions, sum/float64(len(samples)), peak, peakSteal, peakQueue, first.drops, last.drops)
	window := time.Since(started)
	to := time.Now()
	for _, people := range everyone {
		for _, person := range people {
			for _, other := range people {
				if other == person {
					continue
				}
				assertAudioFlows(t, person.name+" hearing "+other.name, person.media, trackKey(other, micName), to.Add(-window), to)
			}
		}
	}
	if last.drops > first.drops {
		t.Errorf("the node dropped %d datagrams for a full receive buffer", last.drops-first.drops)
	}
}

func renewGrants(svc *service, scope protocol.Scope) {
	var controls []protocol.SourceControl
	for _, source := range []string{"microphone", "camera", "screen", "screen_audio"} {
		controls = append(controls, protocol.SourceControl{ParticipantID: scope.ParticipantID, Source: source, Action: protocol.SourceGrant, Revision: 1})
	}
	encoded, err := json.Marshal(protocol.SourceControlRequest{TenantID: scope.TenantID, EpisodeID: scope.EpisodeID, Controls: controls})
	if err != nil {
		return
	}
	if response, err := svc.client.Post(svc.baseURL+"/v1/episodes/sources", "application/json", bytes.NewReader(encoded)); err == nil {
		_ = response.Body.Close()
	}
}

func liveClient(t *testing.T) *http.Client {
	t.Helper()
	pem, err := os.ReadFile(os.Getenv("SFU_LIVE_CA"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pem)
	pair, err := tls.LoadX509KeyPair(os.Getenv("SFU_LIVE_CERT"), os.Getenv("SFU_LIVE_KEY"))
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "chalk-sfu", Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}

func readyz(t *testing.T, svc *service) protocol.ReadyResponse {
	t.Helper()
	response, err := svc.client.Get(svc.baseURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var ready protocol.ReadyResponse
	if err := json.NewDecoder(response.Body).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	return ready
}
