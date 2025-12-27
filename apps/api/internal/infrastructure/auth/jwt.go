package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var (
	ErrInvalidToken = errors.New("invalid token")
	ErrExpiredToken = errors.New("token has expired")
	ErrInvalidClaim = errors.New("invalid token claims")
)

// JWTConfig holds JWT configuration
type JWTConfig struct {
	SecretKey          string
	AccessTokenExpiry  time.Duration
	RefreshTokenExpiry time.Duration
	Issuer             string
}

// DefaultJWTConfig returns sensible defaults
func DefaultJWTConfig() JWTConfig {
	return JWTConfig{
		SecretKey:          "chalk-dev-secret-change-in-production",
		AccessTokenExpiry:  15 * time.Minute,
		RefreshTokenExpiry: 7 * 24 * time.Hour,
		Issuer:             "chalk",
	}
}

// JWTService handles JWT token operations
type JWTService struct {
	config JWTConfig
}

// NewJWTService creates a new JWT service
func NewJWTService(config JWTConfig) *JWTService {
	return &JWTService{config: config}
}

// jwtClaims wraps our claims for jwt-go
type jwtClaims struct {
	jwt.RegisteredClaims
	TenantID    uuid.UUID         `json:"tenant_id"`
	RoomID      uuid.UUID         `json:"room_id,omitempty"`
	DisplayName string            `json:"display_name,omitempty"`
	Role        string            `json:"role,omitempty"`
	Permissions auth.Permissions  `json:"permissions,omitempty"`
	CFAuthToken string            `json:"cf_auth_token,omitempty"`
	TokenType   string            `json:"type"` // access or refresh
}

// GenerateAccessToken creates a new access token
func (s *JWTService) GenerateAccessToken(claims auth.Claims) (string, error) {
	now := time.Now()
	expiresAt := now.Add(s.config.AccessTokenExpiry)

	jwtClaims := jwtClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   claims.Subject,
			Issuer:    s.config.Issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			ID:        generateTokenID(),
		},
		TenantID:    claims.TenantID,
		RoomID:      claims.RoomID,
		DisplayName: claims.DisplayName,
		Role:        claims.Role,
		Permissions: claims.Permissions,
		CFAuthToken: claims.CFAuthToken,
		TokenType:   "access",
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwtClaims)
	return token.SignedString([]byte(s.config.SecretKey))
}

// GenerateRefreshToken creates a new refresh token
func (s *JWTService) GenerateRefreshToken(tenantID uuid.UUID, subject string) (string, error) {
	now := time.Now()
	expiresAt := now.Add(s.config.RefreshTokenExpiry)

	jwtClaims := jwtClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   subject,
			Issuer:    s.config.Issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			ID:        generateTokenID(),
		},
		TenantID:  tenantID,
		TokenType: "refresh",
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwtClaims)
	return token.SignedString([]byte(s.config.SecretKey))
}

// GenerateTokenPair creates both access and refresh tokens
func (s *JWTService) GenerateTokenPair(claims auth.Claims) (*auth.TokenPair, error) {
	accessToken, err := s.GenerateAccessToken(claims)
	if err != nil {
		return nil, err
	}

	refreshToken, err := s.GenerateRefreshToken(claims.TenantID, claims.Subject)
	if err != nil {
		return nil, err
	}

	return &auth.TokenPair{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		TokenType:    "Bearer",
		ExpiresIn:    int(s.config.AccessTokenExpiry.Seconds()),
		ExpiresAt:    time.Now().Add(s.config.AccessTokenExpiry),
	}, nil
}

// ValidateToken validates a token and returns the claims
func (s *JWTService) ValidateToken(tokenString string) (*auth.Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &jwtClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return []byte(s.config.SecretKey), nil
	})

	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrExpiredToken
		}
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*jwtClaims)
	if !ok || !token.Valid {
		return nil, ErrInvalidClaim
	}

	return &auth.Claims{
		Subject:     claims.Subject,
		IssuedAt:    claims.IssuedAt.Time,
		ExpiresAt:   claims.ExpiresAt.Time,
		TenantID:    claims.TenantID,
		RoomID:      claims.RoomID,
		DisplayName: claims.DisplayName,
		Role:        claims.Role,
		Permissions: claims.Permissions,
		CFAuthToken: claims.CFAuthToken,
	}, nil
}

// ValidateRefreshToken validates a refresh token
func (s *JWTService) ValidateRefreshToken(tokenString string) (uuid.UUID, string, error) {
	token, err := jwt.ParseWithClaims(tokenString, &jwtClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return []byte(s.config.SecretKey), nil
	})

	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return uuid.Nil, "", ErrExpiredToken
		}
		return uuid.Nil, "", ErrInvalidToken
	}

	claims, ok := token.Claims.(*jwtClaims)
	if !ok || !token.Valid || claims.TokenType != "refresh" {
		return uuid.Nil, "", ErrInvalidClaim
	}

	return claims.TenantID, claims.Subject, nil
}

func generateTokenID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
