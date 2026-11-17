package control

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// v1 guards an operation: the caller must hold the expected service identity. A failure is
// answered and then logged on the trail under the operation's name, with the scope the handler
// noted and the request's trace.
func (s *Server) v1(operation string, handle func(http.ResponseWriter, *http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who := &attribution{}
		ctx, cancel := context.WithTimeout(context.WithValue(r.Context(), attributionKey{}, who), requestDeadline)
		defer cancel()
		r = r.WithContext(ctx)
		err := errForbidden
		if hasIdentity(r.TLS, s.cfg.ClientIdentity) {
			err = handle(w, r)
		}
		if err == nil {
			return
		}
		found := writeProblem(w, err)
		s.node.ControlFailed(who.scope, r.PathValue(protocol.SessionConnectionWildcard), operation, found.status, found.code, traceOf(r), err)
	})
}

// attribution is the scope a request named, which the handler notes once it has decoded the body,
// so a failure after that point carries the ids.
type attribution struct{ scope protocol.Scope }

type attributionKey struct{}

// noteScope tells v1 whose request this is.
func noteScope(r *http.Request, scope protocol.Scope) {
	if who, ok := r.Context().Value(attributionKey{}).(*attribution); ok {
		who.scope = scope
	}
}
