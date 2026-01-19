package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spf13/cobra"
)

var (
	joinLatency = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "webrtc_join_latency_seconds",
		Help:    "Time to complete WebRTC join",
		Buckets: prometheus.ExponentialBuckets(0.1, 2, 10),
	})

	activeConnections = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "webrtc_active_connections",
		Help: "Number of active WebRTC connections",
	})

	connectionErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "webrtc_connection_errors_total",
		Help: "Total WebRTC connection errors",
	})
)

func init() {
	prometheus.MustRegister(joinLatency, activeConnections, connectionErrors)
}

type Config struct {
	BaseURL      string
	TenantID     string
	APIKey       string
	RoomID       string
	Participants int
	Duration     time.Duration
	RampUp       time.Duration
	MetricsPort  int
}

type Participant struct {
	ID          string `json:"id"`
	Token       string `json:"token"`
	CFAuthToken string `json:"cf_auth_token"`
}

type AuthResponse struct {
	AccessToken string `json:"access_token"`
}

type RoomResponse struct {
	ID string `json:"id"`
}

func main() {
	var cfg Config

	rootCmd := &cobra.Command{
		Use:   "webrtc-load",
		Short: "WebRTC load testing client for Chalk",
		Run: func(cmd *cobra.Command, args []string) {
			runLoadTest(cfg)
		},
	}

	rootCmd.Flags().StringVar(&cfg.BaseURL, "url", "https://api-stress.chalk.example.com", "API base URL")
	rootCmd.Flags().StringVar(&cfg.TenantID, "tenant", "", "Tenant ID")
	rootCmd.Flags().StringVar(&cfg.APIKey, "api-key", "", "API key")
	rootCmd.Flags().StringVar(&cfg.RoomID, "room", "", "Room ID (create new if empty)")
	rootCmd.Flags().IntVar(&cfg.Participants, "participants", 10, "Number of participants")
	rootCmd.Flags().DurationVar(&cfg.Duration, "duration", 5*time.Minute, "Test duration")
	rootCmd.Flags().DurationVar(&cfg.RampUp, "ramp-up", 30*time.Second, "Ramp-up time")
	rootCmd.Flags().IntVar(&cfg.MetricsPort, "metrics-port", 9090, "Prometheus metrics port")

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runLoadTest(cfg Config) {
	// Start metrics server
	go func() {
		http.Handle("/metrics", promhttp.Handler())
		log.Printf("Metrics server on :%d", cfg.MetricsPort)
		if err := http.ListenAndServe(fmt.Sprintf(":%d", cfg.MetricsPort), nil); err != nil {
			log.Printf("Metrics server error: %v", err)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	go func() {
		<-sigCh
		log.Println("Shutting down...")
		cancel()
	}()

	// Get auth token
	token, err := getAuthToken(cfg.BaseURL, cfg.TenantID, cfg.APIKey)
	if err != nil {
		log.Fatalf("Failed to get auth token: %v", err)
	}

	// Create or use existing room
	roomID := cfg.RoomID
	if roomID == "" {
		roomID, err = createRoom(cfg.BaseURL, token)
		if err != nil {
			log.Fatalf("Failed to create room: %v", err)
		}
		log.Printf("Created room: %s", roomID)
	}

	// Spawn participants with ramp-up
	var wg sync.WaitGroup
	participantInterval := cfg.RampUp / time.Duration(cfg.Participants)

	for i := 0; i < cfg.Participants; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			runParticipant(ctx, cfg, token, roomID, idx)
		}(i)

		select {
		case <-ctx.Done():
			break
		case <-time.After(participantInterval):
		}
	}

	// Wait for duration or cancellation
	select {
	case <-ctx.Done():
	case <-time.After(cfg.Duration):
		cancel()
	}

	wg.Wait()
	log.Println("Load test complete")
}

func runParticipant(ctx context.Context, cfg Config, token, roomID string, idx int) {
	start := time.Now()

	// Add participant via API
	participant, err := addParticipant(cfg.BaseURL, token, roomID, fmt.Sprintf("LoadUser-%d", idx))
	if err != nil {
		connectionErrors.Inc()
		log.Printf("Participant %d: failed to add: %v", idx, err)
		return
	}

	// Connect to Cloudflare RealtimeKit
	// (Simplified - actual implementation would use CF Calls SDK)
	if err := connectRTK(ctx, participant); err != nil {
		connectionErrors.Inc()
		log.Printf("Participant %d: RTK connect failed: %v", idx, err)
		return
	}

	joinLatency.Observe(time.Since(start).Seconds())
	activeConnections.Inc()
	defer activeConnections.Dec()

	log.Printf("Participant %d: connected in %v", idx, time.Since(start))

	// Simulate media activity
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Simulate toggling video/audio
			// In real implementation, would interact with RTK client
		}
	}
}

func getAuthToken(baseURL, tenantID, apiKey string) (string, error) {
	reqBody, _ := json.Marshal(map[string]string{"tenant_id": tenantID})

	req, err := http.NewRequest("POST", baseURL+"/api/v1/auth/token", bytes.NewBuffer(reqBody))
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("auth failed: %d", resp.StatusCode)
	}

	var authResp AuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&authResp); err != nil {
		return "", err
	}

	return authResp.AccessToken, nil
}

func createRoom(baseURL, token string) (string, error) {
	reqBody, _ := json.Marshal(map[string]string{
		"name": fmt.Sprintf("load-test-%d", time.Now().Unix()),
	})

	req, err := http.NewRequest("POST", baseURL+"/api/v1/rooms", bytes.NewBuffer(reqBody))
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("room creation failed: %d", resp.StatusCode)
	}

	var roomResp RoomResponse
	if err := json.NewDecoder(resp.Body).Decode(&roomResp); err != nil {
		return "", err
	}

	return roomResp.ID, nil
}

func addParticipant(baseURL, token, roomID, displayName string) (*Participant, error) {
	reqBody, _ := json.Marshal(map[string]string{
		"external_user_id": fmt.Sprintf("load-%s-%d", displayName, time.Now().UnixNano()),
		"display_name":     displayName,
		"role":             "participant",
	})

	url := fmt.Sprintf("%s/api/v1/rooms/%s/participants", baseURL, roomID)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(reqBody))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("add participant failed: %d", resp.StatusCode)
	}

	var participant Participant
	if err := json.NewDecoder(resp.Body).Decode(&participant); err != nil {
		return nil, err
	}

	return &participant, nil
}

func connectRTK(ctx context.Context, p *Participant) error {
	// Placeholder for Cloudflare RealtimeKit connection
	// In production, this would:
	// 1. Use p.CFAuthToken to authenticate with CF Calls
	// 2. Establish WebRTC connection via Pion
	// 3. Subscribe to media tracks
	return nil
}
