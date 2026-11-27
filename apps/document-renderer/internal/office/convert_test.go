//go:build !windows

package office

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const docxMIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const xlsxMIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

func fakeDriver(t *testing.T, body string) Config {
	t.Helper()
	directory := t.TempDir()
	python := filepath.Join(directory, "python3")
	if err := os.WriteFile(python, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return Config{Soffice: "/opt/soffice", Driver: "driver.py", Python: python, Timeout: 5 * time.Second, MaxPDFSize: MaxPDFBytes}
}

func convertWith(t *testing.T, config Config, mimeType string, input []byte) (string, error) {
	t.Helper()
	workDir := filepath.Join(t.TempDir(), "office")
	output := filepath.Join(t.TempDir(), "out.pdf")
	return workDir, Convert(context.Background(), config, mimeType, input, workDir, output)
}

func validDocx(t *testing.T) []byte {
	return zipOf(t, map[string]string{"[Content_Types].xml": "<Types/>"})
}

func TestConvertRunsDriverWithBoundedArguments(t *testing.T) {
	t.Setenv("CHALK_SECRET_FOR_TEST", "leak")
	config := fakeDriver(t, "echo \"$@\" > args; env > env; printf '%%PDF-1.7' > \"$5\"")
	workDir, err := convertWith(t, config, xlsxMIME, zipOf(t, map[string]string{"[Content_Types].xml": "<Types/>"}))
	if err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(workDir, "args"))
	fields := strings.Fields(string(args))
	if len(fields) != 8 || fields[0] != "-I" || fields[1] != "driver.py" || fields[2] != "/opt/soffice" || fields[6] != "spreadsheet" || fields[7] != "301" {
		t.Fatalf("driver arguments = %q", args)
	}
	if !strings.HasSuffix(fields[3], "in.xlsx") {
		t.Fatalf("input path = %q", fields[3])
	}
	environment, _ := os.ReadFile(filepath.Join(workDir, "env"))
	if strings.Contains(string(environment), "CHALK_SECRET_FOR_TEST") {
		t.Fatal("parent environment leaked into the converter")
	}
	if !strings.Contains(string(environment), "HOME="+filepath.Join(workDir, "home")) {
		t.Fatalf("HOME is not the scratch profile: %s", environment)
	}
	profile, err := os.ReadFile(filepath.Join(workDir, "profile/user/registrymodifications.xcu"))
	if err != nil || !strings.Contains(string(profile), "DisableMacrosExecution") || !strings.Contains(string(profile), "MacroSecurityLevel") {
		t.Fatalf("macro hardening missing from profile: %v", err)
	}
}

func TestConvertUsesDocumentKindForOtherFormats(t *testing.T) {
	config := fakeDriver(t, "echo \"$@\" > args; printf '%%PDF-1.7' > \"$5\"")
	workDir, err := convertWith(t, config, docxMIME, validDocx(t))
	if err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(workDir, "args"))
	if !strings.Contains(string(args), " document 301") {
		t.Fatalf("driver arguments = %q", args)
	}
}

func TestConvertClassifiesFailures(t *testing.T) {
	tests := []struct {
		name   string
		config func() Config
		mime   string
		input  []byte
		want   string
	}{
		{"missing output despite exit zero", func() Config { return fakeDriver(t, "exit 0") }, docxMIME, validDocx(t), CodeCorrupt},
		{"driver error", func() Config { return fakeDriver(t, "echo boom >&2; exit 1") }, docxMIME, validDocx(t), CodeCorrupt},
		{"output is not a pdf", func() Config { return fakeDriver(t, "echo hello > \"$5\"") }, docxMIME, validDocx(t), CodeCorrupt},
		{"oversize output", func() Config {
			config := fakeDriver(t, "printf '%%PDF-1.7 padding' > \"$5\"")
			config.MaxPDFSize = 8
			return config
		}, docxMIME, validDocx(t), CodeTooLarge},
		{"wall clock", func() Config {
			config := fakeDriver(t, "exec sleep 5")
			config.Timeout = 200 * time.Millisecond
			return config
		}, docxMIME, validDocx(t), CodeTooLarge},
		{"password protected source never reaches the driver", func() Config { return fakeDriver(t, "printf '%%PDF-1.7' > \"$5\"") }, docxMIME, buildCFB(t, cfbStream{"EncryptedPackage", make([]byte, 5000)}), CodePasswordProtected},
		{"corrupt source", func() Config { return fakeDriver(t, "printf '%%PDF-1.7' > \"$5\"") }, docxMIME, []byte("garbage"), CodeCorrupt},
		{"keynote disabled", func() Config { return fakeDriver(t, "exit 0") }, "application/vnd.apple.keynote", zipOf(t, map[string]string{"a": "b"}), CodeUnsupportedFormat},
		{"no converter installed", func() Config { return Config{Timeout: time.Second} }, docxMIME, validDocx(t), CodeUnsupportedFormat},
		{"not an office type", func() Config { return fakeDriver(t, "exit 0") }, "application/pdf", []byte("%PDF-"), CodeUnsupportedFormat},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := convertWith(t, tc.config(), tc.mime, tc.input)
			assertCode(t, err, tc.want)
		})
	}
}

func TestConvertAcceptsKeynoteWhenEnabled(t *testing.T) {
	config := fakeDriver(t, "printf '%%PDF-1.7' > \"$5\"")
	config.KeynoteOn = true
	if _, err := convertWith(t, config, "application/x-iwork-keynote-sffkey", zipOf(t, map[string]string{"Index/a": "b"})); err != nil {
		t.Fatal(err)
	}
}

func TestCheckOutputRemovesRejectedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.pdf")
	if err := os.WriteFile(path, []byte("%PDF-1.7 0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertCode(t, CheckOutput(path, 19, 10), CodeTooLarge)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("oversize output remains: %v", err)
	}
}

func TestPageLimits(t *testing.T) {
	if MaxPages != 300 || ExportPageLimit != 301 || MaxPDFBytes != 64<<20 {
		t.Fatalf("limits = %d %d %d", MaxPages, ExportPageLimit, MaxPDFBytes)
	}
	if !strings.Contains(TooManyPagesMessage(), "first 300") {
		t.Fatalf("message = %q", TooManyPagesMessage())
	}
}
