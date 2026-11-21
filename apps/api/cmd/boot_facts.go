package main

import (
	"context"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/obs"
)

// bootFacts records the platform witnesses of this boot beside api.starting: the
// release.started fact a release marker is judged against, and the flags snapshot
// whose hash a config change between boots is detected by.
func bootFacts(ctx context.Context, cfg config.Config, logger *slog.Logger) {
	obs.Configure(obs.Config{
		Logger:   logger,
		Module:   "api",
		Env:      cfg.Observability.Environment,
		Platform: "server",
	})
	obs.SetFlags(ctx, apiFlags(cfg))
}

// apiFlags is the effective config-switch map an obs.flags_snapshot carries, one
// entry per switch flags.unrecorded_change watches.
func apiFlags(cfg config.Config) obs.Flags {
	return obs.Flags{
		"sfu_new_episodes":                    !cfg.ChalkSFU.NewEpisodesPaused,
		"default_media_plane":                 string(cfg.DefaultMediaPlane),
		"public_invite_default_media_plane":   string(cfg.PublicInvite.DefaultMediaPlane),
		"request_logs":                        cfg.Observability.RequestLogs,
		"sfu_capture_enabled":                 cfg.ChalkSFU.CaptureEnabled,
		"sfu_colocated_capture":               cfg.ChalkSFU.ColocatedCaptureGrace > 0,
		"recording":                           cfg.Capabilities.Recording,
		"transcription":                       cfg.Capabilities.Transcription,
		"whiteboard_files":                    cfg.Capabilities.WhiteboardFiles,
		"direct_signaling_enabled":            cfg.ChalkSFU.DirectSignalingURL != "",
	}
}
