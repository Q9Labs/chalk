package worker

import (
	"fmt"
	"os"
	"path/filepath"
)

const rendererScratchRoot = "/tmp/chalk-renderer"

// ResetRendererScratch runs once when the runtime process boots. Lambda may
// preserve /tmp for a reused execution environment, so no renderer scratch may
// survive from a previous job or runtime.
func ResetRendererScratch() error {
	if err := os.RemoveAll(rendererScratchRoot); err != nil {
		return fmt.Errorf("wipe renderer scratch area: %w", err)
	}
	return nil
}

func writeSource(source []byte) (string, func() error, error) {
	if err := os.MkdirAll(rendererScratchRoot, 0o700); err != nil {
		return "", func() error { return nil }, err
	}
	directory, err := os.MkdirTemp(rendererScratchRoot, "job-")
	if err != nil {
		return "", func() error { return nil }, err
	}
	cleanup := func() error { return cleanupRendererScratch(directory) }
	path := filepath.Join(directory, "source")
	if err := os.WriteFile(path, source, 0o600); err != nil {
		_ = cleanup()
		return "", func() error { return nil }, err
	}
	return path, cleanup, nil
}

func cleanupRendererScratch(directory string) error {
	if err := os.RemoveAll(directory); err != nil {
		return fmt.Errorf("remove renderer job scratch: %w", err)
	}
	if _, err := os.Stat(directory); err == nil {
		return fmt.Errorf("renderer job scratch remains after cleanup")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect renderer job scratch: %w", err)
	}
	return nil
}
