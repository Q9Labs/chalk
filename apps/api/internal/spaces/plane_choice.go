package spaces

import "github.com/q9labs/chalk/apps/api/internal/mediaplane"

type PlaneChoice struct {
	Plane mediaplane.Provider
	By    mediaplane.Selector
}
