//go:build linux

package worker

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
		allowed := map[string]bool{"RENDER_CHILD_MODE": true, "LD_LIBRARY_PATH": true, "RENDERER_TIMEOUT_PROBE": true}
		for _, item := range os.Environ() {
			key, _, _ := strings.Cut(item, "=")
			if !allowed[key] {
				fmt.Fprintln(os.Stderr, "unexpected child environment key", key)
				os.Exit(16)
			}
		}
		os.Exit(0)
	}
	if os.Getenv("RENDER_CHILD_MODE") == "grouptest" || os.Getenv("RENDER_CHILD_MODE") == "slowtest" {
		child := exec.Command("/bin/sh", "-c", "sleep 30")
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(11)
		}
		if err := os.WriteFile(os.Args[1], []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			os.Exit(12)
		}
		if os.Getenv("RENDER_CHILD_MODE") == "slowtest" {
			time.Sleep(30 * time.Second)
		}
		os.Exit(0)
	}
}

func TestIsolatedChildEnvironmentAndProcessSetup(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "must-not-reach-child")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "must-not-reach-child")
	t.Setenv("AWS_LAMBDA_RUNTIME_API", "must-not-reach-child")
	t.Setenv("CONTROL_API_BASE_URL", "must-not-reach-child")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runIsolatedChild(ctx, executable, "selftest"); err != nil {
		if os.Getenv("RENDER_TEST_QEMU") == "1" && strings.Contains(err.Error(), "invalid argument") {
			t.Skipf("qemu-user cannot create the Linux network namespace: %v", err)
		}
		t.Fatalf("isolated child: %v", err)
	}
}

func TestIsolatedChildRequiresNamespaceSandbox(t *testing.T) {
	command := exec.Command("/bin/sh")
	configureIsolatedChild(command, true)
	if command.SysProcAttr == nil || !command.SysProcAttr.Setpgid {
		t.Fatal("isolated child is not placed in its own process group")
	}
	required := uintptr(syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET)
	if command.SysProcAttr.Unshareflags&required != required {
		t.Fatalf("isolated child namespace flags %#x do not include user and network namespaces", command.SysProcAttr.Unshareflags)
	}
	lambdaCommand := exec.Command("/bin/sh")
	configureIsolatedChild(lambdaCommand, false)
	if lambdaCommand.SysProcAttr == nil || !lambdaCommand.SysProcAttr.Setpgid || lambdaCommand.SysProcAttr.Unshareflags != 0 {
		t.Fatalf("Lambda child attributes = %+v; want process group without namespaces", lambdaCommand.SysProcAttr)
	}
}

func TestIsolatedChildSuccessKillsProcessGroup(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "grandchild.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runIsolatedChild(ctx, executable, "grouptest", pidFile); err != nil {
		t.Fatalf("successful isolated child: %v", err)
	}
	assertProcessDies(t, readGrandchildPID(t, pidFile))
}

func TestIsolatedChildTimeoutKillsProcessGroup(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(t.TempDir(), "grandchild.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	err = runIsolatedChild(ctx, executable, "slowtest", pidFile)
	if err == nil || !strings.Contains(err.Error(), "wall-clock") {
		t.Fatalf("timeout error = %v", err)
	}
	assertProcessDies(t, readGrandchildPID(t, pidFile))
}

func readGrandchildPID(t *testing.T, pidFile string) int {
	t.Helper()
	encoded, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read grandchild pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(encoded)))
	if err != nil {
		t.Fatalf("grandchild pid %q: %v", encoded, err)
	}
	return pid
}

func assertProcessDies(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		stat, readErr := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if os.IsNotExist(readErr) {
			return
		}
		if readErr == nil {
			fields := strings.Fields(string(stat))
			if len(fields) > 2 && fields[2] == "Z" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("grandchild %d survived process-group kill", pid)
		}
		time.Sleep(10 * time.Millisecond)
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
