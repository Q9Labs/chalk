package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"net/url"
	"reflect"
	"slices"
	"strings"
)

// Secrets is the single inventory of secret values held by configuration.
// Reports protect request-carried credentials; Config is a backstop, not an inventory of server-only SDK provider credentials the client never receives.
// Fields declare secret:"true" at their definition. The coverage test requires
// credential-like fields to declare either true or an explicit false exception.
// Connection URLs contribute both the whole value and their decoded password;
// binary keys contribute the encodings a person can paste from configuration.
func (c Config) Secrets() []string {
	var values []string
	var walk func(reflect.Value)
	walk = func(value reflect.Value) {
		for i := 0; i < value.NumField(); i++ {
			field := value.Type().Field(i)
			item := value.Field(i)
			switch field.Tag.Get("secret") {
			case "true":
				values = append(values, secretValues(item)...)
			case "false":
			default:
				if item.Kind() == reflect.Struct {
					walk(item)
				}
			}
		}
	}
	walk(reflect.ValueOf(c))
	slices.Sort(values)
	return slices.Compact(values)
}

func secretValues(value reflect.Value) []string {
	switch value.Kind() {
	case reflect.String:
		text := value.String()
		if text == "" {
			return nil
		}
		values := []string{text}
		if parsed, err := url.Parse(text); err == nil && (parsed.Scheme != "" || parsed.Host != "") {
			if parsed.User != nil {
				if password, ok := parsed.User.Password(); ok && password != "" {
					values = append(values, password)
				}
			}
			// pgx also accepts passwords in query parameters (including the
			// encrypted client-key password), which can override URL userinfo.
			for name, entries := range parsed.Query() {
				name = strings.ToLower(name)
				if strings.Contains(name, "password") || strings.Contains(name, "secret") || strings.Contains(name, "token") || strings.Contains(name, "key") {
					for _, entry := range entries {
						if entry != "" {
							values = append(values, entry)
						}
					}
				}
			}
		}
		return values
	case reflect.Slice:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			data := value.Bytes()
			if len(data) == 0 {
				return nil
			}
			values := encodedSecret(data)
			if key, ok := value.Interface().(ed25519.PrivateKey); ok && len(key) == ed25519.PrivateKeySize {
				values = append(values, encodedSecret(key.Seed())...)
			}
			return values
		}
		var values []string
		for i := 0; i < value.Len(); i++ {
			values = append(values, secretValues(value.Index(i))...)
		}
		return values
	case reflect.Map:
		var values []string
		items := value.MapRange()
		for items.Next() {
			values = append(values, secretValues(items.Value())...)
		}
		return values
	default:
		panic("unsupported secret config field type: " + value.Type().String())
	}
}

func encodedSecret(data []byte) []string {
	return []string{string(data), hex.EncodeToString(data), strings.ToUpper(hex.EncodeToString(data)), base64.StdEncoding.EncodeToString(data), base64.RawStdEncoding.EncodeToString(data), base64.URLEncoding.EncodeToString(data), base64.RawURLEncoding.EncodeToString(data)}
}
