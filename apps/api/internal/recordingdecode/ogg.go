package recordingdecode

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

func copyPCM(output *os.File, inputPath string, outputOffset, maximumBytes int64) (resultErr error) {
	input, err := os.Open(inputPath)
	if err != nil {
		return fmt.Errorf("open decoded PCM: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(input, "close decoded PCM"))
	}()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size()%2 != 0 {
		return fmt.Errorf("%w: decoded PCM is invalid", ErrDecode)
	}
	copyBytes := info.Size()
	if copyBytes > maximumBytes {
		copyBytes = maximumBytes
	}
	section := io.NewOffsetWriter(output, outputOffset)
	if copied, err := io.CopyN(section, input, copyBytes); err != nil || copied != copyBytes {
		return fmt.Errorf("copy decoded PCM: %w", err)
	}
	return nil
}

func opusPacketSamples(payload []byte) (uint64, error) {
	if len(payload) == 0 {
		return 0, errors.New("empty payload")
	}
	configuration := payload[0] >> 3
	var samplesPerFrame uint64
	switch {
	case configuration < 12:
		samplesPerFrame = []uint64{480, 960, 1_920, 2_880}[configuration%4]
	case configuration < 16:
		samplesPerFrame = []uint64{480, 960}[configuration%2]
	default:
		samplesPerFrame = []uint64{120, 240, 480, 960}[configuration%4]
	}
	var frameCount uint64
	switch payload[0] & 0x03 {
	case 0:
		frameCount = 1
	case 1, 2:
		frameCount = 2
	case 3:
		if len(payload) < 2 {
			return 0, errors.New("missing frame count")
		}
		frameCount = uint64(payload[1] & 0x3f)
		if frameCount == 0 {
			return 0, errors.New("zero frame count")
		}
	}
	samples := samplesPerFrame * frameCount
	if samples == 0 || samples > 5_760 {
		return 0, errors.New("packet exceeds 120 milliseconds")
	}
	return samples, nil
}

func patchOggPreSkip(path string) (resultErr error) {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open Ogg header: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close Ogg header"))
	}()
	var fixedHeader [27]byte
	if _, err := io.ReadFull(file, fixedHeader[:]); err != nil || string(fixedHeader[0:4]) != "OggS" {
		return fmt.Errorf("%w: invalid Ogg header", ErrDecode)
	}
	segmentCount := int(fixedHeader[26])
	segmentTable := make([]byte, segmentCount)
	if _, err := io.ReadFull(file, segmentTable); err != nil {
		return fmt.Errorf("%w: invalid Ogg segment table", ErrDecode)
	}
	payloadBytes := 0
	for _, size := range segmentTable {
		payloadBytes += int(size)
	}
	page := make([]byte, 27+segmentCount+payloadBytes)
	copy(page, fixedHeader[:])
	copy(page[27:], segmentTable)
	if _, err := io.ReadFull(file, page[27+segmentCount:]); err != nil {
		return fmt.Errorf("%w: invalid Ogg ID page", ErrDecode)
	}
	payloadOffset := 27 + segmentCount
	if payloadBytes < 19 || string(page[payloadOffset:payloadOffset+8]) != "OpusHead" {
		return fmt.Errorf("%w: missing Ogg OpusHead", ErrDecode)
	}
	binary.LittleEndian.PutUint16(page[payloadOffset+10:payloadOffset+12], 0)
	for index := 22; index < 26; index++ {
		page[index] = 0
	}
	binary.LittleEndian.PutUint32(page[22:26], oggCRC(page))
	if _, err := file.WriteAt(page, 0); err != nil {
		return fmt.Errorf("rewrite Ogg pre-skip: %w", err)
	}
	return nil
}

func oggCRC(value []byte) uint32 {
	var checksum uint32
	for _, octet := range value {
		checksum ^= uint32(octet) << 24
		for bit := 0; bit < 8; bit++ {
			if checksum&0x80000000 != 0 {
				checksum = (checksum << 1) ^ 0x04c11db7
			} else {
				checksum <<= 1
			}
		}
	}
	return checksum
}
