package utilities

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

var ErrInvalidID = errors.New("invalid id")

type ID struct {
	value string
	bytes [16]byte
}

func NewID() (ID, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return ID{}, fmt.Errorf("generate id: %w", err)
	}

	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80

	return IDFromBytes(bytes), nil
}

func ParseID(value string) (ID, error) {
	value = strings.TrimSpace(value)

	bytes, err := parseUUID(value)
	if err != nil {
		return ID{}, ErrInvalidID
	}

	return ID{
		value: formatUUID(bytes),
		bytes: bytes,
	}, nil
}

func IDFromBytes(bytes [16]byte) ID {
	return ID{
		value: formatUUID(bytes),
		bytes: bytes,
	}
}

func (id ID) String() string {
	return id.value
}

func (id ID) Bytes() [16]byte {
	return id.bytes
}

func (id ID) IsZero() bool {
	return id.value == ""
}

func parseUUID(value string) ([16]byte, error) {
	var bytes [16]byte
	if len(value) != 36 {
		return bytes, ErrInvalidID
	}

	if value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return bytes, ErrInvalidID
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
