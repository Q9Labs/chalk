package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

func ingestConfig(headers string) (token, dataset string) {
	for _, header := range strings.Split(headers, ",") {
		key, value, ok := strings.Cut(header, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		decoded, err := url.QueryUnescape(value)
		if err != nil {
			continue
		}
		value = decoded
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "authorization":
			token = strings.TrimPrefix(value, "Bearer ")
		case "x-axiom-dataset":
			dataset = value
		}
	}
	return token, dataset
}

func ingest(ctx context.Context, client *http.Client, endpoint, token string, snapshots []snapshot) error {
	body, err := json.Marshal(snapshots)
	if err != nil {
		return errors.New("alert snapshot encoding failed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return errors.New("alert ingest request failed")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return errors.New("alert snapshot delivery failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("alert snapshot ingest rejected")
	}
	var result struct {
		Ingested int `json:"ingested"`
		Failed   int `json:"failed"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil || result.Failed != 0 || result.Ingested != len(snapshots) {
		return errors.New("alert snapshot ingest incomplete")
	}
	fmt.Println("alert snapshot delivered")
	return nil
}
