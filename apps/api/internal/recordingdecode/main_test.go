package recordingdecode

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	os.Exit(runTestsWithBoundedFFmpeg(m))
}

func runTestsWithBoundedFFmpeg(m *testing.M) (status int) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if errors.Is(err, exec.ErrNotFound) {
		return m.Run()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "find test FFmpeg:", err)
		return 1
	}
	ffmpeg, err = filepath.Abs(ffmpeg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "resolve test FFmpeg:", err)
		return 1
	}
	directory, err := os.MkdirTemp("", "chalk-recordingdecode-ffmpeg-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "create test FFmpeg directory:", err)
		return 1
	}
	defer func() {
		if err := os.RemoveAll(directory); err != nil {
			fmt.Fprintln(os.Stderr, "remove test FFmpeg directory:", err)
			status = 1
		}
	}()

	// Native codec tests launch many short FFmpeg jobs. Automatic encoder and
	// filter pools oversubscribe shared runners even when decoder threads are
	// capped. Keep the cap in this test binary, including its Export subprocesses.
	quotedFFmpeg := "'" + strings.ReplaceAll(ffmpeg, "'", "'\"'\"'") + "'"
	wrapper := "#!/bin/sh\nexec " + quotedFFmpeg + " -cpucount 1 \"$@\"\n"
	if err := os.WriteFile(filepath.Join(directory, "ffmpeg"), []byte(wrapper), 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "write test FFmpeg wrapper:", err)
		return 1
	}
	if err := os.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH")); err != nil {
		fmt.Fprintln(os.Stderr, "set test FFmpeg path:", err)
		return 1
	}
	return m.Run()
}
