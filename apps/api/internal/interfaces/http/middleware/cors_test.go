package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestCORS_AllowedOrigins(t *testing.T) {
	allowedOrigins := []string{
		"http://localhost:3070",
		"http://localhost:3000",
		"http://127.0.0.1:3070",
		"http://127.0.0.1:3000",
		"https://chalk.q9labs.ai",
		"https://chalk-5bc.pages.dev",
	}

	for _, origin := range allowedOrigins {
		t.Run("allowed_"+origin, func(t *testing.T) {
			router := setupTestGin()
			router.Use(CORS())
			router.GET("/test", func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"status": "ok"})
			})

			req := httptest.NewRequest("GET", "/test", nil)
			req.Header.Set("Origin", origin)
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code)
			assert.Equal(t, origin, w.Header().Get("Access-Control-Allow-Origin"))
		})
	}
}

func TestCORS_DisallowedOrigins(t *testing.T) {
	disallowedOrigins := []string{
		"http://localhost:8080",
		"http://evil.com",
		"https://malicious-site.com",
		"http://localhost:3000.evil.com",
	}

	for _, origin := range disallowedOrigins {
		t.Run("disallowed_"+origin, func(t *testing.T) {
			router := setupTestGin()
			router.Use(CORS())
			router.GET("/test", func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"status": "ok"})
			})

			req := httptest.NewRequest("GET", "/test", nil)
			req.Header.Set("Origin", origin)
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code)
			// Should not set Access-Control-Allow-Origin for disallowed origins
			assert.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
		})
	}
}

func TestCORS_PreflightRequest(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())
	router.OPTIONS("/test", func(c *gin.Context) {
		// This shouldn't be called, CORS middleware handles OPTIONS
		c.JSON(http.StatusOK, gin.H{})
	})
	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	req := httptest.NewRequest("OPTIONS", "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// OPTIONS should return 204 No Content
	assert.Equal(t, http.StatusNoContent, w.Code)
	assert.Equal(t, "http://localhost:3000", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestCORS_AllowedHeaders(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())
	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	allowHeaders := w.Header().Get("Access-Control-Allow-Headers")
	assert.Contains(t, allowHeaders, "Content-Type")
	assert.Contains(t, allowHeaders, "Authorization")
	assert.Contains(t, allowHeaders, "X-API-Key")
	assert.Contains(t, allowHeaders, "X-CSRF-Token")
}

func TestCORS_AllowedMethods(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())
	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	allowMethods := w.Header().Get("Access-Control-Allow-Methods")
	assert.Contains(t, allowMethods, "POST")
	assert.Contains(t, allowMethods, "GET")
	assert.Contains(t, allowMethods, "PUT")
	assert.Contains(t, allowMethods, "PATCH")
	assert.Contains(t, allowMethods, "DELETE")
	assert.Contains(t, allowMethods, "OPTIONS")
}

func TestCORS_AllowCredentials(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())
	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, "true", w.Header().Get("Access-Control-Allow-Credentials"))
}

func TestCORS_NoOriginHeader(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())
	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	// No Origin header
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	// No Access-Control-Allow-Origin should be set
	assert.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
	// But other headers should still be set
	assert.Equal(t, "true", w.Header().Get("Access-Control-Allow-Credentials"))
}

func TestCORS_PostRequest(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())
	router.POST("/test", func(c *gin.Context) {
		c.JSON(http.StatusCreated, gin.H{"status": "created"})
	})

	req := httptest.NewRequest("POST", "/test", nil)
	req.Header.Set("Origin", "https://chalk.q9labs.ai")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusCreated, w.Code)
	assert.Equal(t, "https://chalk.q9labs.ai", w.Header().Get("Access-Control-Allow-Origin"))
}

func TestCORS_ContinuesToNextHandler(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())

	handlerCalled := false
	router.GET("/test", func(c *gin.Context) {
		handlerCalled = true
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	assert.True(t, handlerCalled)
}

func TestCORS_PreflightDoesNotCallHandler(t *testing.T) {
	router := setupTestGin()
	router.Use(CORS())

	handlerCalled := false
	router.GET("/test", func(c *gin.Context) {
		handlerCalled = true
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	req := httptest.NewRequest("OPTIONS", "/test", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	// Handler should not be called for preflight
	assert.False(t, handlerCalled)
	assert.Equal(t, http.StatusNoContent, w.Code)
}
