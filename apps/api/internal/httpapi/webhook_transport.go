package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type createWebhookBody struct {
	Name       string       `json:"name"`
	URL        string       `json:"url"`
	Enabled    optionalBool `json:"enabled"`
	APIVersion int          `json:"api_version"`
	EventTypes []string     `json:"event_types"`
}
type createWebhookContractBody struct {
	Name       string   `json:"name"`
	URL        string   `json:"url"`
	Enabled    bool     `json:"enabled"`
	APIVersion int      `json:"api_version"`
	EventTypes []string `json:"event_types"`
}
type rotateWebhookBody struct {
	RevokePreviousImmediately optionalBool `json:"revoke_previous_immediately"`
}
type rotateWebhookContractBody struct {
	RevokePreviousImmediately bool `json:"revoke_previous_immediately"`
}
type optionalBool struct {
	Set   bool
	Value *bool
}
type optionalInt struct {
	Set   bool
	Value *int
}
type optionalStrings struct {
	Set   bool
	Value *[]string
}

func (o *optionalBool) UnmarshalJSON(data []byte) error {
	o.Set = true
	if string(data) == "null" {
		return nil
	}
	var value bool
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}
func (o *optionalInt) UnmarshalJSON(data []byte) error {
	o.Set = true
	if string(data) == "null" {
		return nil
	}
	var value int
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}
func (o *optionalStrings) UnmarshalJSON(data []byte) error {
	o.Set = true
	if string(data) == "null" {
		return nil
	}
	var value []string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

type patchWebhookBody struct {
	Name       utilities.OptionalString `json:"name"`
	URL        utilities.OptionalString `json:"url"`
	Enabled    optionalBool             `json:"enabled"`
	APIVersion optionalInt              `json:"api_version"`
	EventTypes optionalStrings          `json:"event_types"`
}

// patchWebhookContractBody describes the public PATCH body without exposing the
// presence-tracking wrappers used by the JSON decoder.
type patchWebhookContractBody struct {
	Name       string   `json:"name,omitempty"`
	URL        string   `json:"url,omitempty"`
	Enabled    bool     `json:"enabled,omitempty"`
	APIVersion int      `json:"api_version,omitempty"`
	EventTypes []string `json:"event_types,omitempty"`
}

func (b patchWebhookBody) toInput(revision int, key string) webhooks.PatchInput {
	return webhooks.PatchInput{Name: b.Name.Value, URL: b.URL.Value, Enabled: b.Enabled.Value, APIVersion: b.APIVersion.Value, EventTypes: b.EventTypes.Value, ExpectedRevision: revision, IdempotencyKey: key}
}
func (b patchWebhookBody) valid() bool {
	return (!b.Name.Set || b.Name.Value != nil) && (!b.URL.Set || b.URL.Value != nil) && (!b.Enabled.Set || b.Enabled.Value != nil) && (!b.APIVersion.Set || b.APIVersion.Value != nil) && (!b.EventTypes.Set || b.EventTypes.Value != nil)
}

type createWebhookRequest struct {
	TenantID utilities.ID
	Key      string
	Body     createWebhookBody
}
type listWebhooksRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
}
type webhookIDsRequest struct{ TenantID, EndpointID utilities.ID }
type patchWebhookRequest struct {
	TenantID, EndpointID utilities.ID
	Revision             int
	Key                  string
	Body                 patchWebhookBody
}
type deleteWebhookRequest struct {
	TenantID, EndpointID utilities.ID
	Revision             int
	Key                  string
}
type rotateWebhookRequest struct {
	TenantID, EndpointID utilities.ID
	Key                  string
	Body                 rotateWebhookBody
}
type webhookActionRequest struct {
	TenantID, EndpointID utilities.ID
	Key                  string
}
type listWebhookDeliveriesRequest struct {
	TenantID, EndpointID utilities.ID
	Filters              webhooks.DeliveryFilters
	Page                 pagination.PageRequest
}
type webhookDeliveryIDsRequest struct{ TenantID, EndpointID, DeliveryID utilities.ID }
type webhookDeliveryActionRequest struct {
	TenantID, EndpointID, DeliveryID utilities.ID
	Key                              string
}

func decodeCreateWebhookRequest(r *http.Request) (createWebhookRequest, error) {
	ids, err := decodeWebhookIDs(r, false)
	if err != nil {
		return createWebhookRequest{}, err
	}
	body, err := decodeJSONBody[createWebhookBody](r)
	if err != nil || !body.Enabled.Set || body.Enabled.Value == nil {
		return createWebhookRequest{}, apiErrorInvalidRequest
	}
	return createWebhookRequest{TenantID: ids.TenantID, Key: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
}
func decodeListWebhooksRequest(r *http.Request) (listWebhooksRequest, error) {
	ids, err := decodeWebhookIDs(r, false)
	if err != nil {
		return listWebhooksRequest{}, err
	}
	page, err := parsePageRequest(r)
	return listWebhooksRequest{TenantID: ids.TenantID, Page: page}, err
}
func decodeWebhookIDsRequest(r *http.Request) (webhookIDsRequest, error) {
	return decodeWebhookIDs(r, true)
}
func decodePatchWebhookRequest(r *http.Request) (patchWebhookRequest, error) {
	ids, err := decodeWebhookIDs(r, true)
	if err != nil {
		return patchWebhookRequest{}, err
	}
	revision, err := parseIfMatch(r.Header.Get("If-Match"))
	if err != nil {
		return patchWebhookRequest{}, err
	}
	body, err := decodeJSONBody[patchWebhookBody](r)
	if err != nil || !body.valid() {
		return patchWebhookRequest{}, apiErrorInvalidRequest
	}
	return patchWebhookRequest{TenantID: ids.TenantID, EndpointID: ids.EndpointID, Revision: revision, Key: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
}
func decodeDeleteWebhookRequest(r *http.Request) (deleteWebhookRequest, error) {
	ids, err := decodeWebhookIDs(r, true)
	if err != nil {
		return deleteWebhookRequest{}, err
	}
	revision, err := parseIfMatch(r.Header.Get("If-Match"))
	return deleteWebhookRequest{TenantID: ids.TenantID, EndpointID: ids.EndpointID, Revision: revision, Key: r.Header.Get(idempotencyKeyHeader)}, err
}
func decodeRotateWebhookRequest(r *http.Request) (rotateWebhookRequest, error) {
	ids, err := decodeWebhookIDs(r, true)
	if err != nil {
		return rotateWebhookRequest{}, err
	}
	body, err := decodeJSONBody[rotateWebhookBody](r)
	if err != nil || !body.RevokePreviousImmediately.Set || body.RevokePreviousImmediately.Value == nil {
		return rotateWebhookRequest{}, apiErrorInvalidRequest
	}
	return rotateWebhookRequest{TenantID: ids.TenantID, EndpointID: ids.EndpointID, Key: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
}
func decodeWebhookActionRequest(r *http.Request) (webhookActionRequest, error) {
	ids, err := decodeWebhookIDs(r, true)
	return webhookActionRequest{TenantID: ids.TenantID, EndpointID: ids.EndpointID, Key: r.Header.Get(idempotencyKeyHeader)}, err
}
func decodeListWebhookDeliveriesRequest(r *http.Request) (listWebhookDeliveriesRequest, error) {
	ids, err := decodeWebhookIDs(r, true)
	if err != nil {
		return listWebhookDeliveriesRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listWebhookDeliveriesRequest{}, err
	}
	query := r.URL.Query()
	return listWebhookDeliveriesRequest{TenantID: ids.TenantID, EndpointID: ids.EndpointID, Page: page, Filters: webhooks.DeliveryFilters{States: query["state"], EventTypes: query["event_type"]}}, nil
}
func decodeWebhookDeliveryIDsRequest(r *http.Request) (webhookDeliveryIDsRequest, error) {
	ids, err := decodeWebhookIDs(r, true)
	if err != nil {
		return webhookDeliveryIDsRequest{}, err
	}
	deliveryID, err := utilities.ParseID(chi.URLParam(r, "delivery_id"))
	if err != nil {
		return webhookDeliveryIDsRequest{}, apiErrorInvalidWebhookDeliveryID
	}
	return webhookDeliveryIDsRequest{TenantID: ids.TenantID, EndpointID: ids.EndpointID, DeliveryID: deliveryID}, nil
}
func decodeWebhookDeliveryActionRequest(r *http.Request) (webhookDeliveryActionRequest, error) {
	ids, err := decodeWebhookDeliveryIDsRequest(r)
	return webhookDeliveryActionRequest{TenantID: ids.TenantID, EndpointID: ids.EndpointID, DeliveryID: ids.DeliveryID, Key: r.Header.Get(idempotencyKeyHeader)}, err
}

func decodeWebhookIDs(r *http.Request, endpointRequired bool) (webhookIDsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return webhookIDsRequest{}, err
	}
	result := webhookIDsRequest{TenantID: tenantID}
	if !endpointRequired {
		return result, nil
	}
	result.EndpointID, err = utilities.ParseID(chi.URLParam(r, "endpoint_id"))
	if err != nil {
		return webhookIDsRequest{}, apiErrorInvalidWebhookEndpointID
	}
	return result, nil
}
func parseIfMatch(value string) (int, error) {
	if len(value) < 3 || value[0] != '"' || value[len(value)-1] != '"' {
		return 0, apiErrorWebhookRevisionConflict
	}
	revision, err := strconv.Atoi(value[1 : len(value)-1])
	if err != nil || revision < 1 {
		return 0, apiErrorWebhookRevisionConflict
	}
	return revision, nil
}

func webhookEndpointIDParameter() APIParameterContract {
	return APIParameterContract{Name: "endpoint_id", In: "path", Type: "string", Required: true}
}
func webhookDeliveryIDParameter() APIParameterContract {
	return APIParameterContract{Name: "delivery_id", In: "path", Type: "string", Required: true}
}
func webhookDeliveryFilterParameters() []APIParameterContract {
	return []APIParameterContract{
		{Name: "state", In: "query", Type: "array", ItemsType: "string", Enum: []string{"pending", "retry_wait", "delivering", "succeeded", "exhausted", "canceled", "erased"}},
		{Name: "event_type", In: "query", Type: "array", ItemsType: "string", Enum: []string{"endpoint.test", "participant.joined", "participant.left", "recording.completed", "recording.failed", "recording.started", "room.archived", "room.created", "room.restored", "room.updated", "session.ended", "session.started", "transcript.completed", "transcript.failed", "transcript.started"}},
	}
}
func ifMatchParameter() APIParameterContract {
	return APIParameterContract{Name: "If-Match", In: "header", Type: "string", Required: true, Pattern: `^"[1-9][0-9]*"$`}
}
