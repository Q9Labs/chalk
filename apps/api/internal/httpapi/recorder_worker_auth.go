package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type RecorderWorkerVerifier interface {
	Verify(request *http.Request) (workeridentity.Identity, error)
}

type recorderWorkerIdentityContextKey struct{}

func requireRecorderWorker(verifier RecorderWorkerVerifier, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if verifier == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is unavailable")
			return
		}

		identity, err := verifier.Verify(request)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "worker_unauthorized", "Worker authentication required")
			return
		}

		ctx := context.WithValue(request.Context(), recorderWorkerIdentityContextKey{}, identity)
		next.ServeHTTP(w, request.WithContext(ctx))
	})
}

func recorderWorkerIdentity(ctx context.Context) (workeridentity.Identity, bool) {
	identity, ok := ctx.Value(recorderWorkerIdentityContextKey{}).(workeridentity.Identity)
	return identity, ok
}
