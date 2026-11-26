package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/document-renderer/internal/render"
)

func runBenchmark(path string) error {
	started := time.Now()
	source, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	mode := envOr("RENDER_BENCHMARK_MODE", "page")
	if mode == "page" {
		bitmap, width, height, _, err := render.RenderPDFPage(source, 1, 1600)
		if err != nil {
			return err
		}
		thumbnail, thumbWidth, thumbHeight, err := render.ResizeBGRA(bitmap, width, height, 240)
		if err != nil {
			return err
		}
		if _, err := render.EncodeWebP(bitmap, width, height, 78); err != nil {
			return err
		}
		if _, err := render.EncodeWebP(thumbnail, thumbWidth, thumbHeight, 78); err != nil {
			return err
		}
		fmt.Printf(`{"mode":"page","durationMs":%d,"width":%d,"height":%d}`+"\n", time.Since(started).Milliseconds(), width, height)
		return nil
	}
	inventory, _, err := render.PDFInventoryFromBytes(source)
	if err != nil {
		return err
	}
	input, err := os.CreateTemp("", "benchmark-source-*")
	if err != nil {
		return err
	}
	inputPath := input.Name()
	_ = input.Close()
	if err := os.WriteFile(inputPath, source, 0o600); err != nil {
		return err
	}
	defer os.Remove(inputPath)
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	semaphore := make(chan struct{}, 2)
	errorsChannel := make(chan error, inventory.PageCount)
	var wait sync.WaitGroup
	for page := 1; page <= inventory.PageCount; page++ {
		page := page
		wait.Add(1)
		go func() {
			defer wait.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			prefix := fmt.Sprintf("%s-%d", inputPath, page)
			command := exec.Command(executable, inputPath, prefix, fmt.Sprint(page), "1600")
			command.Env = append(os.Environ(), "RENDER_PAGE_MODE=1")
			if output, err := command.CombinedOutput(); err != nil {
				errorsChannel <- fmt.Errorf("page %d: %w: %s", page, err, output)
				return
			}
			bitmap, err := os.ReadFile(prefix + ".raw")
			if err != nil {
				errorsChannel <- err
				return
			}
			var metadata struct{ Width, Height int }
			metadataBytes, err := os.ReadFile(prefix + ".json")
			if err == nil {
				err = json.Unmarshal(metadataBytes, &metadata)
			}
			if err != nil {
				errorsChannel <- err
				return
			}
			if len(bitmap) != metadata.Width*metadata.Height*4 {
				errorsChannel <- fmt.Errorf("page %d bitmap length mismatch", page)
				return
			}
			if _, err := render.EncodeWebP(bitmap, metadata.Width, metadata.Height, 78); err != nil {
				errorsChannel <- err
				return
			}
			thumbnail, width, height, err := render.ResizeBGRA(bitmap, metadata.Width, metadata.Height, 240)
			if err != nil {
				errorsChannel <- err
				return
			}
			if _, err := render.EncodeWebP(thumbnail, width, height, 78); err != nil {
				errorsChannel <- err
			}
			_ = os.Remove(prefix + ".raw")
			_ = os.Remove(prefix + ".json")
		}()
	}
	wait.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		if err != nil {
			return err
		}
	}
	fmt.Printf(`{"mode":"full","pages":%d,"durationMs":%d}`+"\n", inventory.PageCount, time.Since(started).Milliseconds())
	return nil
}
