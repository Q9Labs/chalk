// Package recordercontrollease enforces one control process per persistent state file.
package recordercontrollease

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func Acquire(statePath string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		return nil, fmt.Errorf("create control state directory: %w", err)
	}
	file, err := os.OpenFile(statePath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open control process lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		closeErr := file.Close()
		if closeErr != nil {
			return nil, fmt.Errorf("close rejected control process lock: %w", closeErr)
		}
		return nil, fmt.Errorf("control state already owned by another process: %w", err)
	}
	// Keep the inode in place across restart; closing the descriptor releases ownership.
	return file, nil
}
