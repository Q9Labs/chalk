package media

import "github.com/q9labs/chalk/features/media/sfu/internal/obs"

func init() {
	obs.Configure(obs.Config{Module: "sfu", Env: "test"})
}
