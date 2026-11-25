//go:build linux

package worker

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func init() {
	if os.Getenv("RENDER_PROTECT_TEST_PARENT") == "1" {
		if err := MakeProcessNonDumpable(); err != nil {
			os.Exit(14)
		}
		fmt.Fprintln(os.Stdout, os.Getpid())
		time.Sleep(30 * time.Second)
		os.Exit(15)
	}
	if os.Getenv("RENDER_PROTECT_TEST_READER") == "1" && len(os.Args) > 1 {
		if _, err := os.ReadFile("/proc/" + os.Args[1] + "/environ"); err != nil {
			os.Exit(13)
		}
		os.Exit(12)
	}
}

func init() {
	if os.Getenv("RENDER_CHILD_MODE") == "selftest" {
		os.Exit(0)
	}
}

func TestIsolatedChildEnvironmentAndProcessSetup(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "must-not-reach-child")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runIsolatedChild(ctx, executable, "selftest"); err != nil {
		if os.Getenv("RENDER_TEST_QEMU") == "1" && strings.Contains(err.Error(), "invalid argument") {
			t.Skipf("qemu-user cannot create the Linux network namespace: %v", err)
		}
		t.Fatalf("isolated child: %v", err)
	}
}

func TestIsolatedNamespaceErrorDetection(t *testing.T) {
	if !isolatedNamespaceError(&os.PathError{Op: "fork/exec", Path: "/tmp/renderer", Err: syscall.EPERM}) {
		t.Fatal("expected EPERM fork failure to trigger the namespace fallback")
	}
	if !isolatedNamespaceError(&os.PathError{Op: "fork/exec", Path: "/tmp/renderer", Err: syscall.EINVAL}) {
		t.Fatal("expected EINVAL fork failure to trigger the namespace fallback")
	}
	if isolatedNamespaceError(os.ErrNotExist) {
		t.Fatal("unrelated process errors must not disable namespace isolation")
	}
}

func TestNonDumpableParentHidesEnvironmentFromSameUIDChild(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	secret := "render-parent-secret-" + strings.ReplaceAll(t.Name(), "/", "-")
	parent := exec.Command(executable)
	parent.Env = append(os.Environ(), "RENDER_PROTECT_TEST_PARENT=1", "RENDER_PROTECT_SECRET="+secret)
	output, err := parent.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	parent.Stderr = os.Stderr
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = parent.Process.Kill()
		_ = parent.Wait()
	}()
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil {
		t.Fatalf("read protected parent pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("protected parent pid %q: %v", line, err)
	}
	reader := exec.Command(executable, strconv.Itoa(pid))
	reader.Env = []string{"RENDER_PROTECT_TEST_READER=1"}
	if libraryPath := os.Getenv("LD_LIBRARY_PATH"); libraryPath != "" {
		reader.Env = append(reader.Env, "LD_LIBRARY_PATH="+libraryPath)
	}
	readerOutput, err := reader.CombinedOutput()
	exit, isExit := err.(*exec.ExitError)
	if !isExit || exit.ExitCode() != 13 {
		t.Fatalf("reader exit = %v, output %s; want exit 13 because /proc/<parent>/environ is unreadable", err, readerOutput)
	}
}
