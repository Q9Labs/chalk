package episodes

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"
)

func lifecycleFingerprint(value any) [32]byte {
	normalized, _ := json.Marshal(value)
	return sha256.Sum256(normalized)
}

func canonicalJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return appendCanonicalJSON(nil, value)
}

func appendCanonicalJSON(target []byte, value any) []byte {
	switch value := value.(type) {
	case nil:
		return append(target, "null"...)
	case bool:
		return append(target, strconv.FormatBool(value)...)
	case string:
		encoded, _ := json.Marshal(value)
		return append(target, encoded...)
	case json.Number:
		return append(target, canonicalJSONNumber(string(value))...)
	case []any:
		target = append(target, '[')
		for index, item := range value {
			if index > 0 {
				target = append(target, ',')
			}
			target = appendCanonicalJSON(target, item)
		}
		return append(target, ']')
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		target = append(target, '{')
		for index, key := range keys {
			if index > 0 {
				target = append(target, ',')
			}
			encoded, _ := json.Marshal(key)
			target = append(target, encoded...)
			target = append(target, ':')
			target = appendCanonicalJSON(target, value[key])
		}
		return append(target, '}')
	default:
		return target
	}
}

func canonicalJSONNumber(number string) string {
	negative := strings.HasPrefix(number, "-")
	if negative {
		number = number[1:]
	}
	exponent := new(big.Int)
	if exponentIndex := strings.IndexAny(number, "eE"); exponentIndex >= 0 {
		exponent.SetString(number[exponentIndex+1:], 10)
		number = number[:exponentIndex]
	}
	fractionDigits := 0
	if decimalIndex := strings.IndexByte(number, '.'); decimalIndex >= 0 {
		fractionDigits = len(number) - decimalIndex - 1
		number = number[:decimalIndex] + number[decimalIndex+1:]
	}
	number = strings.TrimLeft(number, "0")
	if number == "" {
		return "0"
	}
	trailingZeros := len(number) - len(strings.TrimRight(number, "0"))
	number = number[:len(number)-trailingZeros]
	exponent.Sub(exponent, big.NewInt(int64(fractionDigits)))
	exponent.Add(exponent, big.NewInt(int64(trailingZeros)))
	sign := ""
	if negative {
		sign = "-"
	}
	scientificExponent := new(big.Int).Add(exponent, big.NewInt(int64(len(number)-1)))
	if scientificExponent.IsInt64() {
		value := scientificExponent.Int64()
		decimalPosition := int64(len(number)) + exponent.Int64()
		if value >= -6 && value < 21 {
			switch {
			case decimalPosition <= 0:
				return sign + "0." + strings.Repeat("0", int(-decimalPosition)) + number
			case decimalPosition >= int64(len(number)):
				return sign + number + strings.Repeat("0", int(decimalPosition-int64(len(number))))
			default:
				return sign + number[:decimalPosition] + "." + number[decimalPosition:]
			}
		}
	}
	mantissa := number[:1]
	if len(number) > 1 {
		mantissa += "." + number[1:]
	}
	exponentSign := ""
	if scientificExponent.Sign() >= 0 {
		exponentSign = "+"
	}
	return sign + mantissa + "e" + exponentSign + scientificExponent.String()
}

func canonicalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	normalized := value.UTC().Format(time.RFC3339Nano)
	return &normalized
}
