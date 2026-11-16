//go:build !unix

package recorderworker

import "github.com/q9labs/chalk/apps/api/internal/workerresources"

func sampleProcessResources() (workerresources.Sample, error) {
	return workerresources.Sample{}, errLinuxOnly
}
