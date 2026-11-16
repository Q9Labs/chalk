//go:build !unix

package recordercontrollease

import (
	"errors"
	"os"
)

func Acquire(string) (*os.File, error) {
	return nil, errors.New("recorder control lease runs only on Linux")
}
