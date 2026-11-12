package main

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

// buildWebhooks wires the webhook service and its delivery dispatcher.
func (w *wiring) buildWebhooks() error {
	protector, err := webhooks.NewAESGCMKeyring(w.cfg.Webhooks.CurrentKeyVersion, w.cfg.Webhooks.EncryptionKeys)
	if err != nil {
		return fmt.Errorf("configure webhook encryption: %w", err)
	}
	w.opts.Webhooks = webhooks.NewService(postgres.NewWebhookRepository(w.pool, protector), protector)
	owner, err := utilities.NewID()
	if err != nil {
		return fmt.Errorf("create webhook dispatcher owner: %w", err)
	}
	dispatcher := webhooks.NewDispatcher(postgres.NewWebhookDispatchRepository(w.pool), protector, webhooks.NewDeliveryClient(nil), owner.String(), w.obs.logger)
	w.jobs = append(w.jobs, backgroundJob{name: "webhook dispatcher", run: dispatcher.Run})
	return nil
}
