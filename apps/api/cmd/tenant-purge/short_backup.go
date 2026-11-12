package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

const (
	beforeImageMagic   = "CHALKTPB1"
	beforeImagePrefix  = "before-image-"
	beforeImageSuffix  = ".json.enc"
	receiptSuffix      = ".receipt.private.json"
	beforeImageRetains = 14 * 24 * time.Hour
)

type shortBackup struct {
	Path        string    `json:"path"`
	CipherSHA   string    `json:"cipher_sha256"`
	PlainSHA    string    `json:"plain_sha256"`
	RetainUntil time.Time `json:"retain_until"`
}

// backupCipher builds the AES-GCM cipher from the base64 key in the environment.
func backupCipher() (cipher.AEAD, error) {
	key, err := base64.StdEncoding.DecodeString(os.Getenv("CHALK_TENANT_PURGE_BACKUP_KEY"))
	if err != nil || len(key) != 32 {
		return nil, errors.New("32-byte base64 backup key required in environment")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// checkBackupDirectory requires an absolute, owner-only directory that no
// symlink reaches and no Git checkout contains.
func checkBackupDirectory(directory string) error {
	if !filepath.IsAbs(directory) {
		return errors.New("absolute private backup directory required")
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return err
	}
	if resolved != filepath.Clean(directory) {
		return errors.New("backup directory must not traverse symlinks")
	}
	info, err := os.Stat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("backup directory must be owner-only")
	}
	for p := directory; ; p = filepath.Dir(p) {
		if _, err := os.Lstat(filepath.Join(p, ".git")); err == nil {
			return errors.New("before-images must be outside Git")
		}
		if filepath.Dir(p) == p {
			return nil
		}
	}
}

func shortBackupSink(directory string) (func(context.Context, tenantpurge.Plan) (shortBackup, error), error) {
	if err := checkBackupDirectory(directory); err != nil {
		return nil, err
	}
	gcm, err := backupCipher()
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context, plan tenantpurge.Plan) (shortBackup, error) {
		if err := ctx.Err(); err != nil {
			return shortBackup{}, err
		}
		raw, err := json.Marshal(plan)
		if err != nil {
			return shortBackup{}, err
		}
		nonce := make([]byte, gcm.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return shortBackup{}, err
		}
		magic := []byte(beforeImageMagic)
		encrypted := gcm.Seal(append(append([]byte{}, magic...), nonce...), nonce, raw, magic)
		path, err := writeDurable(directory, beforeImagePrefix+"*"+beforeImageSuffix, encrypted)
		if err != nil {
			return shortBackup{}, err
		}
		plainSHA := sha256.Sum256(raw)
		cipherSHA := sha256.Sum256(encrypted)
		receipt := shortBackup{path, hex.EncodeToString(cipherSHA[:]), hex.EncodeToString(plainSHA[:]), time.Now().UTC().Add(beforeImageRetains)}
		if err := writeReceipt(directory, path+receiptSuffix, receipt); err != nil {
			return receipt, err
		}
		return receipt, ctx.Err()
	}, nil
}

// writeDurable creates a file in directory, writes data, and syncs the file and the directory.
func writeDurable(directory, pattern string, data []byte) (string, error) {
	file, err := os.CreateTemp(directory, pattern)
	if err != nil {
		return "", err
	}
	path := file.Name()
	if _, err := file.Write(data); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	return path, syncDirectory(directory)
}

func writeReceipt(directory, path string, receipt shortBackup) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(file).Encode(receipt); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return syncDirectory(directory)
}

func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// carryShortBeforeImages copies the deferred seeds of earlier purge before-images
// into plan. It reads only authenticated, durably receipted before-images, so it
// works after a partial run or an unknown commit outcome without another
// production write.
func carryShortBeforeImages(directory string, plan *tenantpurge.Plan) error {
	gcm, err := backupCipher()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), beforeImagePrefix) || !strings.HasSuffix(entry.Name(), beforeImageSuffix) {
			continue
		}
		before, receipted, err := readBeforeImage(gcm, filepath.Join(directory, entry.Name()))
		if err != nil {
			return err
		}
		if !receipted || before.Kind != "purge" {
			continue
		}
		if err := tenantpurge.CarryDeferredSeeds(plan, before); err != nil {
			return err
		}
	}
	return nil
}

// readBeforeImage decrypts one before-image and checks it against its receipt.
// receipted is false for an image that has no receipt yet.
func readBeforeImage(gcm cipher.AEAD, path string) (before tenantpurge.Plan, receipted bool, err error) {
	info, err := os.Lstat(path)
	if err != nil {
		return before, false, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return before, false, errors.New("before-image must be private regular file")
	}
	if _, err := os.Lstat(path + receiptSuffix); os.IsNotExist(err) {
		return before, false, nil
	} else if err != nil {
		return before, false, err
	}
	var receipt shortBackup
	if err := readPrivate(path+receiptSuffix, &receipt); err != nil {
		return before, false, err
	}
	if receipt.Path != path {
		return before, false, errors.New("before-image receipt path differs")
	}
	encrypted, err := os.ReadFile(path)
	if err != nil {
		return before, false, err
	}
	hash := sha256.Sum256(encrypted)
	if hex.EncodeToString(hash[:]) != receipt.CipherSHA {
		return before, false, errors.New("before-image ciphertext differs")
	}
	magic := []byte(beforeImageMagic)
	if len(encrypted) < len(magic)+gcm.NonceSize() || string(encrypted[:len(magic)]) != string(magic) {
		return before, false, errors.New("invalid before-image format")
	}
	raw, err := gcm.Open(nil, encrypted[len(magic):len(magic)+gcm.NonceSize()], encrypted[len(magic)+gcm.NonceSize():], magic)
	if err != nil {
		return before, false, err
	}
	plain := sha256.Sum256(raw)
	if hex.EncodeToString(plain[:]) != receipt.PlainSHA {
		return before, false, errors.New("before-image plaintext differs")
	}
	return before, true, json.Unmarshal(raw, &before)
}
