//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestChildModeRendersValidPDFWhenPrctlDenied(t *testing.T) {
	pdfiumLibrary, err := filepath.Abs(filepath.Join("..", "..", "native", "pdfium", "lib", "libpdfium.so"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pdfiumLibrary); err != nil {
		t.Skipf("pdfium runtime is unavailable: %v", err)
	}
	temporary := t.TempDir()
	renderer := filepath.Join(temporary, "renderer")
	build := exec.Command("go", "build", "-o", renderer, ".")
	buildOutput, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("build renderer: %v\n%s", err, buildOutput)
	}
	source, err := filepath.Abs(filepath.Join("..", "..", "testdata", "normal.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	helperSource := filepath.Join(temporary, "seccomp-exec.c")
	if err := os.WriteFile(helperSource, []byte(`#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
	if (argc < 2) return 70;
	struct sock_filter filter[] = {
		BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
		BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_prctl, 0, 1),
		BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
		BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
	};
	struct sock_fprog program = { .len = 4, .filter = filter };
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 71;
	if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) return 72;
	errno = 0;
	if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != -1 || errno != EPERM) return 74;
	execv(argv[1], argv + 1);
	return 73;
}
`), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(temporary, "seccomp-exec")
	buildHelper := exec.Command("cc", "-O2", "-o", helper, helperSource)
	if output, err := buildHelper.CombinedOutput(); err != nil {
		t.Skipf("cannot build prctl-denying helper: %v\n%s", err, output)
	}
	prefix := filepath.Join(temporary, "inventory")
	command := exec.Command(helper, renderer, source, prefix, "application/pdf")
	command.Env = []string{
		"RENDER_CHILD_MODE=inventory",
		"LD_LIBRARY_PATH=" + filepath.Dir(pdfiumLibrary),
	}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("valid PDF child with prctl denied: %v\n%s", err, output)
	}
	if _, err := os.Stat(prefix + ".inventory"); err != nil {
		t.Fatalf("valid PDF child did not write inventory with prctl denied: %v\n%s", err, output)
	}
}
