// Package main provides a CLI tool to register Cloudflare RealtimeKit webhooks.
// Run: go run ./cmd/setup-webhook
//
// Required environment variables:
// - CLOUDFLARE_ACCOUNT_ID
// - CLOUDFLARE_APP_ID
// - CLOUDFLARE_API_TOKEN
// - API_PUBLIC_URL (e.g., https://chalk-api.q9labs.ai)
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/joho/godotenv"
)

func main() {
	// Load .env if present
	_ = godotenv.Load()

	accountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	appID := os.Getenv("CLOUDFLARE_APP_ID")
	apiToken := os.Getenv("CLOUDFLARE_API_TOKEN")
	publicURL := os.Getenv("API_PUBLIC_URL")

	// Validate required env vars
	missing := []string{}
	if accountID == "" {
		missing = append(missing, "CLOUDFLARE_ACCOUNT_ID")
	}
	if appID == "" {
		missing = append(missing, "CLOUDFLARE_APP_ID")
	}
	if apiToken == "" {
		missing = append(missing, "CLOUDFLARE_API_TOKEN")
	}
	if publicURL == "" {
		missing = append(missing, "API_PUBLIC_URL")
	}

	if len(missing) > 0 {
		log.Fatalf("Missing required environment variables: %s", strings.Join(missing, ", "))
	}

	ctx := context.Background()

	client := cloudflare.NewClient(cloudflare.Config{
		AccountID: accountID,
		AppID:     appID,
		APIToken:  apiToken,
	})

	fmt.Println("Checking existing webhooks...")

	webhooks, err := client.ListWebhooks(ctx)
	if err != nil {
		// Cloudflare returns 404 when no webhooks exist - treat as empty list
		if strings.Contains(err.Error(), "404") {
			webhooks = []cloudflare.Webhook{}
		} else {
			log.Fatalf("Failed to list webhooks: %v", err)
		}
	}

	webhookURL := strings.TrimSuffix(publicURL, "/") + "/webhooks/cloudflare/recording"

	fmt.Printf("Target webhook URL: %s\n", webhookURL)
	fmt.Printf("Found %d existing webhook(s)\n", len(webhooks))

	// Check if webhook already exists
	for _, wh := range webhooks {
		fmt.Printf("  - [%s] %s -> %s (enabled: %v)\n", wh.ID, wh.Name, wh.URL, wh.Enabled)
		if wh.URL == webhookURL {
			fmt.Println("\nWebhook already registered for this URL.")
			fmt.Printf("Webhook ID: %s\n", wh.ID)
			if !wh.Enabled {
				fmt.Println("WARNING: Webhook is disabled. Enable it to receive recording events.")
			}
			return
		}
	}

	// Create new webhook
	// Note: Cloudflare RealtimeKit doesn't support custom secrets - uses RSA-SHA256 with their public key
	fmt.Println("\nCreating new webhook...")

	newWebhook, err := client.CreateWebhook(ctx, cloudflare.CreateWebhookRequest{
		Name:    "Chalk Recording Webhook",
		URL:     webhookURL,
		Events:  []string{cloudflare.WebhookEventRecordingStatusUpdate},
		Enabled: true,
	})
	if err != nil {
		log.Fatalf("Failed to create webhook: %v", err)
	}

	fmt.Println("\nWebhook created successfully!")
	fmt.Printf("  ID:      %s\n", newWebhook.ID)
	fmt.Printf("  Name:    %s\n", newWebhook.Name)
	fmt.Printf("  URL:     %s\n", newWebhook.URL)
	fmt.Printf("  Events:  %v\n", newWebhook.Events)
	fmt.Printf("  Enabled: %v\n", newWebhook.Enabled)
	fmt.Println("\nRecordings will now trigger webhooks to your API.")
}
