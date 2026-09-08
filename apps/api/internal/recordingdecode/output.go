package recordingdecode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const wavHeaderBytes = 44

type execCommandRunner struct{}

func (execCommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	var output boundedBuffer
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	if output.exceeded {
		return output.Bytes(), fmt.Errorf("command output exceeded %d bytes", MaximumCommandOutput)
	}
	return output.Bytes(), err
}

type boundedBuffer struct {
	bytes.Buffer
	exceeded bool
}

func (buffer *boundedBuffer) Write(value []byte) (int, error) {
	originalLength := len(value)
	remaining := MaximumCommandOutput - buffer.Len()
	if remaining <= 0 {
		buffer.exceeded = true
		return originalLength, nil
	}
	if len(value) > remaining {
		buffer.exceeded = true
		value = value[:remaining]
	}
	_, _ = buffer.Buffer.Write(value)
	return originalLength, nil
}

func runFFmpeg(ctx context.Context, runner CommandRunner, ffmpegPath string, args ...string) error {
	output, err := runner.Run(ctx, ffmpegPath, args...)
	if len(output) > MaximumCommandOutput {
		output = output[:MaximumCommandOutput]
	}
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			return fmt.Errorf("%w: ffmpeg: %v", ErrDecode, err)
		}
		return fmt.Errorf("%w: ffmpeg: %v: %s", ErrDecode, err, message)
	}
	return nil
}

func createSilentWAV(path string, sampleRate, channels int, samplesPerChannel int64) (resultErr error) {
	if sampleRate <= 0 || channels <= 0 || samplesPerChannel < 0 {
		return fmt.Errorf("%w: invalid WAV dimensions", ErrDecode)
	}
	dataBytes := samplesPerChannel * int64(channels) * 2
	if dataBytes < 0 || dataBytes > int64(^uint32(0))-36 {
		return fmt.Errorf("%w: WAV exceeds RIFF bound", ErrOutputLimit)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("create WAV: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close WAV"))
	}()
	if err := writeWAVHeader(file, sampleRate, channels, dataBytes); err != nil {
		return err
	}
	if err := file.Truncate(wavHeaderBytes + dataBytes); err != nil {
		return fmt.Errorf("size WAV: %w", err)
	}
	return nil
}

func writeWAVHeader(writer io.WriterAt, sampleRate, channels int, dataBytes int64) error {
	if dataBytes < 0 || dataBytes > int64(^uint32(0))-36 {
		return fmt.Errorf("%w: WAV exceeds RIFF bound", ErrOutputLimit)
	}
	var header [wavHeaderBytes]byte
	copy(header[0:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:8], uint32(36+dataBytes))
	copy(header[8:12], "WAVE")
	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16)
	binary.LittleEndian.PutUint16(header[20:22], 1)
	binary.LittleEndian.PutUint16(header[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(header[24:28], uint32(sampleRate))
	byteRate := sampleRate * channels * 2
	binary.LittleEndian.PutUint32(header[28:32], uint32(byteRate))
	binary.LittleEndian.PutUint16(header[32:34], uint16(channels*2))
	binary.LittleEndian.PutUint16(header[34:36], 16)
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], uint32(dataBytes))
	if _, err := writer.WriteAt(header[:], 0); err != nil {
		return fmt.Errorf("write WAV header: %w", err)
	}
	return nil
}

func fileFacts(path string) (byteSize int64, checksum string, resultErr error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(file, "close media output"))
	}()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return 0, "", fmt.Errorf("media output is not a regular file")
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return 0, "", err
	}
	return info.Size(), hex.EncodeToString(digest.Sum(nil)), nil
}

func validateIndex(root string, index Index) error {
	if index.SchemaVersion != SchemaVersion || index.RecordingID == "" || index.EpisodeID == "" ||
		index.Clock.Origin != "capture_ready" || index.Clock.Timebase != "recording_relative_ms" ||
		index.Clock.OriginAuthorityID == "" || index.Clock.CaptureEpoch <= 0 || index.Clock.DurationMS < 0 ||
		index.Sources == nil || index.Discontinuities == nil {
		return fmt.Errorf("%w: invalid decoded media index", ErrDecode)
	}
	seen := make(map[string]struct{}, len(index.Sources))
	for _, source := range index.Sources {
		if source.SourceID == "" || source.ParticipantID == "" || source.ParticipantGeneration <= 0 ||
			source.TrackID == "" || source.TrackEpoch <= 0 || source.StartMS < 0 || source.EndMS <= source.StartMS ||
			source.EndMS > index.Clock.DurationMS || !isLowerSHA256(source.SHA256) || source.ByteSize <= 0 {
			return fmt.Errorf("%w: invalid decoded source", ErrDecode)
		}
		if _, exists := seen[source.SourceID]; exists {
			return fmt.Errorf("%w: duplicate decoded source", ErrDecode)
		}
		seen[source.SourceID] = struct{}{}
		if err := validateRelativeOutput(root, source.Path, source.ByteSize, source.SHA256); err != nil {
			return err
		}
	}
	if index.Mix.Path == "" || index.Mix.Codec != "pcm_s16le" || index.Mix.Container != "wav" ||
		index.Mix.ContentType != "audio/wav" || index.Mix.SampleRateHz != 48_000 || index.Mix.Channels != 2 ||
		index.Mix.StartMS != 0 || index.Mix.EndMS != index.Clock.DurationMS || index.Mix.ByteSize <= 0 ||
		!isLowerSHA256(index.Mix.SHA256) {
		return fmt.Errorf("%w: invalid decoded mix", ErrDecode)
	}
	return validateRelativeOutput(root, index.Mix.Path, index.Mix.ByteSize, index.Mix.SHA256)
}

func validateRelativeOutput(root, relative string, expectedSize int64, expectedSHA256 string) error {
	if relative == "" || filepath.IsAbs(relative) || filepath.ToSlash(relative) != relative ||
		filepath.Clean(relative) != relative || relative == "." || strings.HasPrefix(relative, "../") {
		return fmt.Errorf("%w: unsafe decoded media path", ErrDecode)
	}
	path := filepath.Join(root, filepath.FromSlash(relative))
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: decoded media path escapes root", ErrDecode)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != expectedSize {
		return fmt.Errorf("%w: decoded media file mismatch", ErrDecode)
	}
	_, actualSHA256, err := fileFacts(path)
	if err != nil || actualSHA256 != expectedSHA256 {
		return fmt.Errorf("%w: decoded media checksum mismatch", ErrDecode)
	}
	return nil
}

func enforceOutputLimit(root string) error {
	var total int64
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || (!entry.IsDir() && !info.Mode().IsRegular()) {
			return fmt.Errorf("decoded media output contains an unsupported file")
		}
		if info.Mode().IsRegular() {
			if info.Size() > MaximumOutputBytes-total {
				return ErrOutputLimit
			}
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("%w: %v", ErrOutputLimit, err)
	}
	return nil
}

func syncTree(root string) error {
	var directories []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		syncErr := file.Sync()
		closeErr := file.Close()
		return errors.Join(syncErr, closeErr)
	})
	if err != nil {
		return fmt.Errorf("sync decoded media files: %w", err)
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := syncDirectory(directories[index]); err != nil {
			return err
		}
	}
	return nil
}

func syncDirectory(path string) (resultErr error) {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open decoded media directory for sync: %w", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, closeFileWithContext(directory, "close decoded media directory"))
	}()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync decoded media directory: %w", err)
	}
	return nil
}
