package tenants

import (
	"encoding/hex"
	"strings"
)

type TenantID struct {
	value string
	bytes [16]byte
}

func ParseTenantID(value string) (TenantID, error) {
	value = strings.TrimSpace(value)

	bytes, err := parseCanonicalUUID(value)
	if err != nil {
		return TenantID{}, ErrInvalidTenantID
	}

	return TenantID{
		value: formatUUID(bytes),
		bytes: bytes,
	}, nil
}

func TenantIDFromBytes(bytes [16]byte) TenantID {
	return TenantID{
		value: formatUUID(bytes),
		bytes: bytes,
	}
}

func (id TenantID) String() string {
	return id.value
}

func (id TenantID) Bytes() [16]byte {
	return id.bytes
}

func (id TenantID) IsZero() bool {
	return id.value == ""
}

func parseCanonicalUUID(value string) ([16]byte, error) {
	var bytes [16]byte
	if len(value) != 36 {
		return bytes, ErrInvalidTenantID
	}

	if value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return bytes, ErrInvalidTenantID
	}

	hexValue := value[0:8] + value[9:13] + value[14:18] + value[19:23] + value[24:36]
	decoded, err := hex.DecodeString(hexValue)
	if err != nil {
		return bytes, err
	}

	copy(bytes[:], decoded)
	return bytes, nil
}

func formatUUID(bytes [16]byte) string {
	var buf [36]byte

	hex.Encode(buf[0:8], bytes[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], bytes[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], bytes[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], bytes[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], bytes[10:16])

	return string(buf[:])
}
