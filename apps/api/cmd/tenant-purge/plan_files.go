package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

func readPrivate[T interface{}](path string, target *T) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("input must be a private regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("input has trailing data")
	}
	return nil
}

func writePrivate(path string, value tenantpurge.Plan) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(value); err != nil {
		return err
	}
	return file.Sync()
}

func verifyBackup(plan tenantpurge.Plan, receipt tenantpurge.BackupReceipt) error {
	if err := receipt.Validate(plan, time.Now().UTC()); err != nil {
		return err
	}
	info, err := os.Lstat(receipt.ArchivePath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("backup must be a private regular encrypted archive")
	}
	file, err := os.Open(receipt.ArchivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != receipt.ArchiveDigest {
		return errors.New("encrypted backup digest differs")
	}
	return nil
}

func summarize(plan tenantpurge.Plan) error {
	type count struct {
		Name string `json:"table"`
		Rows int64  `json:"rows"`
	}
	var counts []count
	var total int64
	for _, table := range plan.Tables {
		counts = append(counts, count{table.Name, table.Count})
		total += table.Count
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Kind   string  `json:"kind"`
		Rows   int64   `json:"rows"`
		Tables []count `json:"tables"`
	}{plan.Kind, total, counts})
}
