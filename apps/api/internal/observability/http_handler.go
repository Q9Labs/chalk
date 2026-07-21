package observability

import "net/http"

func (d Diagnostics) WrapHTTP(handler http.Handler) http.Handler {
	if handler == nil {
		return nil
	}
	middleware := []func(http.Handler) http.Handler{OTelHTTPMiddleware(), JourneyMiddleware}
	if d.config.RequestLogs != RequestLogOff {
		middleware = append(middleware, RequestMiddleware(d.logger, RequestLogConfig{
			Mode:          d.config.RequestLogs,
			SampleRate:    d.config.RequestSampleRate,
			SlowThreshold: d.config.SlowRequestThreshold,
		}))
	}
	for index := len(middleware) - 1; index >= 0; index-- {
		handler = middleware[index](handler)
	}
	return handler
}
