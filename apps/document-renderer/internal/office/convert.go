package office

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const ConvertTimeout = 60 * time.Second

const childTimeout = ConvertTimeout - 5*time.Second

type Config struct {
	Soffice    string
	Driver     string
	Python     string
	KeynoteOn  bool
	Timeout    time.Duration
	MaxPDFSize int64
}

func ConfigFromEnv() Config {
	python := os.Getenv("RENDERER_PYTHON")
	if python == "" {
		python = "/usr/bin/python3"
	}
	return Config{
		Soffice:    os.Getenv("RENDERER_SOFFICE"),
		Driver:     os.Getenv("RENDERER_OFFICE_DRIVER"),
		Python:     python,
		KeynoteOn:  os.Getenv("RENDERER_KEYNOTE") == "1",
		Timeout:    childTimeout,
		MaxPDFSize: MaxPDFBytes,
	}
}

func (c Config) available(format Format) error {
	if c.Soffice == "" || c.Driver == "" {
		return &Failure{Code: CodeUnsupportedFormat, Message: "this renderer image cannot convert Office documents"}
	}
	if format.Keynote && !c.KeynoteOn {
		return &Failure{Code: CodeUnsupportedFormat, Message: "Keynote documents are not enabled"}
	}
	return nil
}

func Convert(ctx context.Context, config Config, mimeType string, input []byte, workDir, outputPath string) error {
	format, ok := Lookup(mimeType)
	if !ok {
		return &Failure{Code: CodeUnsupportedFormat, Message: "document type " + mimeType + " is not an Office type"}
	}
	if err := config.available(format); err != nil {
		return err
	}
	if err := Precheck(format, input); err != nil {
		return err
	}
	return run(ctx, config, format, input, workDir, outputPath)
}

func run(ctx context.Context, config Config, format Format, input []byte, workDir, outputPath string) error {
	for _, directory := range []string{"profile/user", "home", "tmp", "cache"} {
		if err := os.MkdirAll(filepath.Join(workDir, directory), 0o700); err != nil {
			return err
		}
	}
	inputPath := filepath.Join(workDir, "in."+format.Extension)
	if err := os.WriteFile(inputPath, input, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(workDir, "profile/user/registrymodifications.xcu"), []byte(registryModifications), 0o600); err != nil {
		return err
	}
	kind := "document"
	if format.Spreadsheet {
		kind = "spreadsheet"
	}
	runCtx, cancel := context.WithTimeout(ctx, config.Timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, config.Python, "-I", config.Driver, config.Soffice, inputPath, outputPath, filepath.Join(workDir, "profile"), kind, strconv.Itoa(ExportPageLimit))
	command.Dir = workDir
	command.Env = []string{
		"PATH=/usr/bin:/bin",
		"HOME=" + filepath.Join(workDir, "home"),
		"TMPDIR=" + filepath.Join(workDir, "tmp"),
		"XDG_CACHE_HOME=" + filepath.Join(workDir, "cache"),
		"LANG=C.UTF-8",
		"SAL_USE_VCLPLUGIN=svp",
		"PYTHONDONTWRITEBYTECODE=1",
	}
	var diagnostics cappedBuffer
	command.Stdout = &diagnostics
	command.Stderr = &diagnostics
	runErr := command.Run()
	if runCtx.Err() == context.DeadlineExceeded {
		return &Failure{Code: CodeTooLarge, Message: "conversion exceeded the wall-clock limit"}
	}
	info, statErr := os.Stat(outputPath)
	if statErr != nil || info.IsDir() {
		message := strings.TrimSpace(diagnostics.String())
		if runErr != nil {
			message = fmt.Sprintf("%v: %s", runErr, message)
		}
		return &Failure{Code: CodeCorrupt, Message: "conversion produced no PDF: " + message}
	}
	return CheckOutput(outputPath, info.Size(), config.MaxPDFSize)
}

func CheckOutput(path string, size, limit int64) error {
	if size > limit {
		_ = os.Remove(path)
		return &Failure{Code: CodeTooLarge, Message: fmt.Sprintf("converted PDF is %d bytes; the limit is %d", size, limit)}
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make([]byte, 5)
	if _, err := io.ReadFull(file, header); err != nil || !bytes.Equal(header, []byte("%PDF-")) {
		_ = os.Remove(path)
		return &Failure{Code: CodeCorrupt, Message: "conversion output is not a PDF"}
	}
	return nil
}

type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(chunk []byte) (int, error) {
	if remaining := 2048 - b.Len(); remaining > 0 {
		b.Buffer.Write(chunk[:min(len(chunk), remaining)])
	}
	return len(chunk), nil
}

const registryModifications = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
`
