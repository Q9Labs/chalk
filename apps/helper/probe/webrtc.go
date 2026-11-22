// This probe consumes a continuously encoded VP8 IVF stream on stdin.
// Run it from apps/api so it uses the repository's pinned Pion version.
package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
)

//go:embed index.html
var page []byte

func main() {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	origin := "http://" + listener.Addr().String()
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		log.Fatal(err)
	}
	path := "/" + hex.EncodeToString(nonce[:]) + "/"
	var used atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path || r.Host != listener.Addr().String() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		_, _ = w.Write(page)
	})
	mux.HandleFunc("POST "+path+"offer", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != listener.Addr().String() || r.Header.Get("Origin") != origin || r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var offer webrtc.SessionDescription
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&offer); err != nil || offer.Type != webrtc.SDPTypeOffer {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !used.CompareAndSwap(false, true) {
			w.WriteHeader(http.StatusConflict)
			return
		}
		answer, err := connect(r.Context(), offer)
		if err != nil {
			log.Printf("WebRTC handoff failed: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(answer)
	})
	server := http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	fmt.Println(origin + path + "?handoff=1")
	log.Fatal(server.Serve(listener))
}

func connect(ctx context.Context, offer webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIPFilter(net.IP.IsLoopback)
	settings.SetRemoteIPFilter(net.IP.IsLoopback)
	connection, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			_ = connection.Close()
		}
	}()
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "filtered-screen", "capture-probe",
	)
	if err != nil {
		return nil, err
	}
	sender, err := connection.AddTrack(track)
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	var started atomic.Bool
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("WebRTC connection: %s", state)
		switch state {
		case webrtc.PeerConnectionStateConnected:
			if started.CompareAndSwap(false, true) {
				go func() {
					defer connection.Close()
					if err := writeSamples(connection, track); err != nil {
						log.Printf("WebRTC frame handoff stopped: %v", err)
					}
				}()
			}
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateDisconnected:
			_ = connection.Close()
		}
	})
	if err := connection.SetRemoteDescription(offer); err != nil {
		return nil, err
	}
	answer, err := connection.CreateAnswer(nil)
	if err != nil {
		return nil, err
	}
	gathered := webrtc.GatheringCompletePromise(connection)
	if err := connection.SetLocalDescription(answer); err != nil {
		return nil, err
	}
	select {
	case <-gathered:
		failed = false
		return connection.LocalDescription(), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(5 * time.Second):
		return nil, fmt.Errorf("ICE gathering timed out")
	}
}

func writeSamples(connection *webrtc.PeerConnection, track *webrtc.TrackLocalStaticSample) error {
	reader, _, err := ivfreader.NewWith(os.Stdin)
	if err != nil {
		return err
	}
	for connection.ConnectionState() != webrtc.PeerConnectionStateClosed {
		frame, _, err := reader.ParseNextFrame()
		if err != nil {
			return err
		}
		if err := track.WriteSample(media.Sample{Data: frame, Duration: time.Second / 15}); err != nil {
			return err
		}
	}
	return nil
}
