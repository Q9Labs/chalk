package httpapi

import "github.com/q9labs/chalk/apps/api/internal/observability"

func (options *Options) ApplyDiagnostics(diagnostics observability.Diagnostics) {
	if options == nil {
		return
	}
	httpOptions := diagnostics.HTTPOptions()
	options.Middleware = append(options.Middleware, httpOptions.Middleware...)
	options.JourneyMetrics = httpOptions.JourneyMetrics
	if httpOptions.Profiler != nil {
		options.Profiler = httpOptions.Profiler
	}
}
