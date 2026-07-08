package main

import (
	"fmt"
	"net/http"
	"reflect"
	"runtime"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

func main() {
	router := httpapi.NewRouter(httpapi.Options{})
	routes, ok := router.(chi.Routes)
	if !ok {
		panic("router does not expose chi routes")
	}

	if err := chi.Walk(routes, func(method string, route string, handler http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		fmt.Printf("%-7s %-48s handler=%s middleware=%d\n", method, route, handlerName(handler), len(middlewares))
		return nil
	}); err != nil {
		panic(err)
	}
}

func handlerName(handler http.Handler) string {
	value := reflect.ValueOf(handler)
	if value.Kind() == reflect.Func {
		if fn := runtime.FuncForPC(value.Pointer()); fn != nil {
			return fn.Name()
		}
	}

	return fmt.Sprintf("%T", handler)
}
