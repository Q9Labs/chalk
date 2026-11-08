package mediaplane

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

const (
	BindingSchemaVersion            = "media_plane_binding.v1"
	BindingSourceDeploymentDefault  = "deployment_default"
	BindingSourceTenantChalkManaged = "tenant_chalk_managed"
	BindingSourceTenantManaged      = "tenant_managed"
)

var ErrInvalidBinding = errors.New("invalid immutable media plane binding")

// Binding freezes the selected provider application, never its credentials.
// Provider uses the Space selector vocabulary so another adapter can register
// without changing the Recording contract.
type Binding struct {
	SchemaVersion       string `json:"schema_version"`
	Provider            string `json:"provider"`
	ConfigurationSource string `json:"configuration_source"`
	AdapterFingerprint  string `json:"adapter_fingerprint"`
	// Node names the provider node that serves the Episode when the provider runs
	// more than one, so every call for the Episode reaches the same node. It is
	// empty for a provider with one global endpoint, such as Cloudflare.
	Node string `json:"node,omitempty"`
	// NodeIncarnation is the boot incarnation of Node at placement, when the last
	// readiness probe had one. PlacementReason says why the Episode went where it
	// did. Both are optional and additive, so the previous release still reads
	// the binding and a binding written before they existed stays valid.
	NodeIncarnation string          `json:"node_incarnation,omitempty"`
	PlacementReason PlacementReason `json:"placement_reason,omitempty"`
}

// PlacementReason is the bounded reason a new Episode got its provider and node.
type PlacementReason string

const (
	// PlacementPrimary and PlacementStandby name the role of the node that had room:
	// the first configured node is the primary and every later one a standby.
	PlacementPrimary PlacementReason = "primary"
	PlacementStandby PlacementReason = "standby"
	// PlacementOverflowNoRoom, PlacementOverflowDraining and
	// PlacementOverflowNodeUnavailable bind the Episode to Cloudflare because no
	// own-SFU node had room. NoRoom: a node that takes new Episodes was full.
	// Draining: every answering node was draining, a planned state and not a
	// capacity shortage. NodeUnavailable: no node answered ready.
	PlacementOverflowNoRoom          PlacementReason = "overflow_no_room"
	PlacementOverflowDraining        PlacementReason = "overflow_draining"
	PlacementOverflowNodeUnavailable PlacementReason = "overflow_node_unavailable"
	// PlacementNoCapacity keeps the Episode on the first node although no node had
	// room, because the Tenant has no Cloudflare application to take it. The
	// node's admission then refuses the join.
	PlacementNoCapacity PlacementReason = "no_capacity"
)

// ErrPlacementRefused means a new Episode was refused because no own-SFU node had
// room and Cloudflare overflow is off. It is a bounded reason, safe to log.
var ErrPlacementRefused = errors.New("no own sfu node with room (full, draining or not answering) and cloudflare overflow disabled")

// Placement is where a new Episode goes: a node of a provider that runs several,
// or none for a provider with one global endpoint.
type Placement struct {
	Node        string
	Incarnation string
	Reason      PlacementReason
}

func NewBinding(provider, source, applicationID string) (Binding, error) {
	fingerprint, err := AdapterFingerprint(provider, applicationID)
	if err != nil {
		return Binding{}, err
	}
	binding := Binding{SchemaVersion: BindingSchemaVersion, Provider: provider, ConfigurationSource: source, AdapterFingerprint: fingerprint}
	if err := binding.Validate(); err != nil {
		return Binding{}, err
	}
	return binding, nil
}

// Placed records where the Episode goes. The node is not part of the
// fingerprint: it locates the Episode inside the application, it does not pick one.
func (binding Binding) Placed(placement Placement) (Binding, error) {
	binding.Node, binding.NodeIncarnation, binding.PlacementReason = placement.Node, placement.Incarnation, placement.Reason
	if binding.Node != "" && !ValidNodeID(binding.Node) {
		return Binding{}, ErrInvalidBinding
	}
	if err := binding.Validate(); err != nil {
		return Binding{}, err
	}
	return binding, nil
}

// ValidNodeID reports whether a node ID is 1 to 64 lowercase letters, digits or '-',
// starting with a letter. Node IDs are stable names, not host addresses.
func ValidNodeID(node string) bool {
	if len(node) == 0 || len(node) > 64 || node[0] < 'a' || node[0] > 'z' {
		return false
	}
	for _, char := range node {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '-' {
			continue
		}
		return false
	}
	return true
}

// AdapterFingerprint excludes tokens and secrets: rotating a credential must
// not move an existing Episode to another provider application.
func AdapterFingerprint(provider, applicationID string) (string, error) {
	if !validBindingProvider(provider) || applicationID == "" || len(applicationID) > 512 || strings.TrimSpace(applicationID) != applicationID || strings.ContainsRune(applicationID, 0) {
		return "", ErrInvalidBinding
	}
	digest := sha256.Sum256([]byte(provider + "\x00" + applicationID))
	return hex.EncodeToString(digest[:]), nil
}

func (binding Binding) Validate() error {
	if binding.SchemaVersion != BindingSchemaVersion || !validBindingProvider(binding.Provider) {
		return ErrInvalidBinding
	}
	switch binding.ConfigurationSource {
	case BindingSourceDeploymentDefault, BindingSourceTenantChalkManaged, BindingSourceTenantManaged:
	default:
		return ErrInvalidBinding
	}
	if len(binding.AdapterFingerprint) != sha256.Size*2 || strings.ToLower(binding.AdapterFingerprint) != binding.AdapterFingerprint {
		return ErrInvalidBinding
	}
	if _, err := hex.DecodeString(binding.AdapterFingerprint); err != nil {
		return ErrInvalidBinding
	}
	if binding.Node != "" && !ValidNodeID(binding.Node) {
		return ErrInvalidBinding
	}
	if binding.NodeIncarnation != "" && (binding.Node == "" || !ValidIncarnation(binding.NodeIncarnation)) {
		return ErrInvalidBinding
	}
	switch binding.PlacementReason {
	case "", PlacementPrimary, PlacementStandby, PlacementOverflowNoRoom, PlacementOverflowDraining, PlacementOverflowNodeUnavailable, PlacementNoCapacity:
	default:
		return ErrInvalidBinding
	}
	return nil
}

// ValidIncarnation reports whether a node incarnation is 1 to 64 lowercase letters, digits or '-'.
func ValidIncarnation(incarnation string) bool {
	if incarnation == "" || len(incarnation) > 64 {
		return false
	}
	for _, char := range incarnation {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func validBindingProvider(provider string) bool {
	if len(provider) == 0 || len(provider) > 64 || provider[0] < 'a' || provider[0] > 'z' {
		return false
	}
	for _, char := range provider {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '_' {
			continue
		}
		return false
	}
	return true
}
