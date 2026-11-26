package worker

import "os"

func isolatedChildEnvironment(mode string) []string {
	environment := []string{"RENDER_CHILD_MODE=" + mode}
	if libraryPath := os.Getenv("LD_LIBRARY_PATH"); libraryPath != "" {
		environment = append(environment, "LD_LIBRARY_PATH="+libraryPath)
	}
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" || os.Getenv("RENDERER_LAMBDA") == "1" {
		environment = append(environment, "RENDERER_LAMBDA=1")
	}
	if os.Getenv("RENDERER_TIMEOUT_PROBE") == "1" {
		environment = append(environment, "RENDERER_TIMEOUT_PROBE=1")
	}
	return environment
}
