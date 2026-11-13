package recordingdecode

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func writeSpoolPacket(writer io.Writer, packet recordingbundle.RTPPacket) error {
	var header [spoolRecordHeaderBytes]byte
	binary.BigEndian.PutUint64(header[0:8], packet.ExtendedSequenceNumber)
	binary.BigEndian.PutUint32(header[8:12], packet.Timestamp)
	binary.BigEndian.PutUint32(header[12:16], packet.SSRC)
	header[16] = packet.PayloadType
	if packet.Marker {
		header[17] = 1
	}
	binary.BigEndian.PutUint32(header[18:22], uint32(len(packet.Payload)))
	if _, err := writer.Write(header[:]); err != nil {
		return err
	}
	_, err := writer.Write(packet.Payload)
	return err
}

func readSpoolPacket(reader *bufio.Reader) (recordingbundle.RTPPacket, error) {
	var header [spoolRecordHeaderBytes]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return recordingbundle.RTPPacket{}, err
	}
	payloadLength := binary.BigEndian.Uint32(header[18:22])
	if header[17] > 1 || payloadLength > recordingbundle.MaxPacketPayloadBytes {
		return recordingbundle.RTPPacket{}, fmt.Errorf("%w: corrupt RTP spool packet", ErrDecode)
	}
	payload := make([]byte, int(payloadLength))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return recordingbundle.RTPPacket{}, err
	}
	return recordingbundle.RTPPacket{
		ExtendedSequenceNumber: binary.BigEndian.Uint64(header[0:8]), SequenceNumber: uint16(binary.BigEndian.Uint64(header[0:8])),
		Timestamp: binary.BigEndian.Uint32(header[8:12]), SSRC: binary.BigEndian.Uint32(header[12:16]),
		PayloadType: header[16], Marker: header[17] == 1, Payload: payload,
	}, nil
}

func readRegularFile(path string, total *int64) (encoded []byte, resultErr error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: bundle path is required", ErrInvalidRequest)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 {
		return nil, fmt.Errorf("%w: bundle path is not a regular file", ErrInvalidRequest)
	}
	if info.Size() > MaximumInputBytes-*total {
		return nil, fmt.Errorf("%w: encrypted bundle input exceeds bound", ErrInvalidBundle)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read encrypted bundle: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close encrypted bundle"))
	}()
	encoded, err = io.ReadAll(io.LimitReader(file, info.Size()+1))
	if err != nil {
		return nil, fmt.Errorf("read encrypted bundle: %w", err)
	}
	if int64(len(encoded)) != info.Size() {
		return nil, fmt.Errorf("%w: encrypted bundle size changed while reading", ErrInvalidBundle)
	}
	*total += int64(len(encoded))
	return encoded, nil
}

func closeFileWithContext(file *os.File, operation string) error {
	if file == nil {
		return nil
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}

func removeAllWithContext(path, operation string) error {
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}

func removeFileWithContext(path, operation string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}
