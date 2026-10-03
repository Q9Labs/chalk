package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func frozenBackupCommand(path string) (func(context.Context, tenantpurge.Plan) (tenantpurge.BackupReceipt, error), error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(path) || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Mode().Perm()&0100 == 0 {
		return nil, errors.New("backup command must be an absolute private executable regular file")
	}
	return func(ctx context.Context, plan tenantpurge.Plan) (tenantpurge.BackupReceipt, error) {
		var receipt tenantpurge.BackupReceipt
		data, err := json.Marshal(plan)
		if err != nil {
			return receipt, err
		}
		cmd := exec.CommandContext(ctx, path)
		cmd.Stdin = bytes.NewReader(data)
		// The backup process receives before-images, not production SQL access.
		cmd.Env = backupChildEnvironment(os.Environ())
		cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
		cmd.WaitDelay = 5 * time.Second
		var output bytes.Buffer
		cmd.Stdout = &output
		if err := cmd.Run(); err != nil {
			// Never forward subprocess stderr or row values to ordinary logs.
			return receipt, fmt.Errorf("backup command failed: %w", err)
		}
		decoder := json.NewDecoder(&output)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&receipt); err != nil {
			return receipt, errors.New("backup command returned an invalid receipt")
		}
		var extra json.RawMessage
		if err := decoder.Decode(&extra); err != io.EOF {
			return receipt, errors.New("backup command returned trailing data")
		}
		return receipt, verifyBackup(plan.WithoutValues(), receipt)
	}, nil
}

func backupChildEnvironment(parent []string) []string {
	// Non-nil is essential: nil tells os/exec to inherit every credential.
	child := make([]string, 0, len(parent))
	for _, entry := range parent {
		name, _, _ := strings.Cut(entry, "=")
		if name != "CHALK_DATABASE_URL" && !strings.HasPrefix(name, "PG") {
			child = append(child, entry)
		}
	}
	return child
}
