package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"reflect"
	"regexp"
	"slices"
	"testing"
)

func TestConfigCredentialFieldsAreClassified(t *testing.T) {
	credentialName := regexp.MustCompile(`(?i)secret|token|key|password|url`)
	var walk func(reflect.Type, string)
	walk = func(typ reflect.Type, path string) {
		for i := 0; i < typ.NumField(); i++ {
			field := typ.Field(i)
			name := path + "." + field.Name
			classification := field.Tag.Get("secret")
			if field.Type.Kind() == reflect.Struct && classification == "" {
				walk(field.Type, name)
				continue
			}
			if credentialName.MatchString(field.Name) && classification != "true" && classification != "false" {
				t.Errorf("%s must declare secret:\"true\" or an explicit secret:\"false\" exception", name)
			}
			if classification == "true" {
				// Exercise each field's actual type through the inventory, not a
				// second hand-kept list. Unsupported secret types fail here.
				value := reflect.New(field.Type).Elem()
				if field.Type.Kind() == reflect.String {
					value.SetString("config-fixture-" + name)
					if !slices.Contains(secretValues(value), value.String()) {
						t.Errorf("%s omitted from secret values", name)
					}
				} else {
					secretValues(value)
				}
			}
		}
	}
	walk(reflect.TypeOf(Config{}), "Config")
}

func TestConfigSecrets(t *testing.T) {
	key := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	cfg := Config{
		Database:  DatabaseConfig{URL: "postgres://owner:db%2Dpassword@localhost/chalk?password=override%2Dpassword&sslpassword=client-key-password"},
		Redis:     RedisConfig{URL: "redis://default:redis-password@localhost/0"},
		SyncToken: SyncTokenConfig{PrivateKey: key, KeyID: "public-key-id"},
		Webhooks:  WebhookConfig{EncryptionKeys: map[byte][]byte{1: []byte("rotated-encryption-secret")}},
	}
	cfg.API.ServicePrincipal.Secrets = []string{"service-secret-one", "service-secret-two"}
	values := cfg.Secrets()
	for _, secret := range []string{cfg.Database.URL, "db-password", "override-password", "client-key-password", cfg.Redis.URL, "redis-password", "service-secret-one", "service-secret-two", string(key), string(key.Seed()), base64.StdEncoding.EncodeToString(key), base64.StdEncoding.EncodeToString(key.Seed()), base64.StdEncoding.EncodeToString(cfg.Webhooks.EncryptionKeys[1])} {
		if !slices.Contains(values, secret) {
			t.Error("configured secret or its pasted encoding missing")
		}
	}
	if slices.Contains(values, cfg.SyncToken.KeyID) || slices.Contains(values, "") {
		t.Error("public identifiers or empty values treated as secrets")
	}
}
