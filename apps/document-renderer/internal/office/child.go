package office

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

const maxSourceBytes = 256 << 20

// RunChild converts args[0] (input) of type args[2] into the PDF at
// args[1]+".pdf", working inside the input's scratch directory.
func RunChild(args []string) int {
	if len(args) != 3 {
		fmt.Fprintln(os.Stderr, "office child expects input, output prefix and mime type")
		return 2
	}
	info, err := os.Stat(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if info.Size() > maxSourceBytes {
		fmt.Fprintln(os.Stderr, &Failure{Code: CodeTooLarge, Message: "source document is too large"})
		return 1
	}
	input, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), ConvertTimeout)
	defer cancel()
	if err := Convert(ctx, ConfigFromEnv(), args[2], input, filepath.Join(filepath.Dir(args[0]), "office"), args[1]+".pdf"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
