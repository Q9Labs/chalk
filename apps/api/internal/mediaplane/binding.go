package mediaplane

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
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
// Provider is the provider's SettingName, the spelling stored on Spaces.
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
	// Generation counts the moves of a live Episode between allocations (recovery). It is
	// absent until the first move. A move commits only against the generation it read, and
	// the database refuses any other step, so two writers never both win.
	Generation int64 `json:"generation,omitempty"`
	// PreviousAllocations are the allocations the Episode moved away from, newest last,
	// kept so that cleanup targets them and never the current allocation.
	PreviousAllocations []Allocation `json:"previous_allocations,omitempty"`
}

// maxPreviousAllocations bounds the retired allocations a binding remembers.
const maxPreviousAllocations = 4

// Allocation is one Episode's stay on one boot of one node. A node that restarts
// holds nothing of the Episode's earlier incarnation.
type Allocation struct {
	Node        string `json:"node"`
	Incarnation string `json:"incarnation,omitempty"`
}

// ProviderID is the media plane provider the binding names.
func (binding Binding) ProviderID() (Provider, error) {
	provider, err := ParseSettingName(binding.Provider)
	if err != nil {
		return "", ErrInvalidBinding
	}
	return provider, nil
}

// Is reports whether the binding names the provider.
func (binding Binding) Is(provider Provider) bool {
	return binding.Provider == provider.SettingName()
}

// Current is the allocation the binding places the Episode on.
func (binding Binding) Current() Allocation {
	return Allocation{Node: binding.Node, Incarnation: binding.NodeIncarnation}
}

// PlacementReason is the bounded reason a new Episode got its provider and node.
type PlacementReason string

const (
	// PlacementPrimary and PlacementStandby name the role of the node that had room:
	// the first configured node is the primary and every later one a standby.
	PlacementPrimary PlacementReason = "primary"
	PlacementStandby PlacementReason = "standby"
	// PlacementOverflowNoRoom, PlacementOverflowHostGuard,
	// PlacementOverflowDraining and PlacementOverflowNodeUnavailable bind the
	// Episode to Cloudflare because no own-SFU node had room. NoRoom: a node
	// that takes new Episodes was out of packet budget. HostGuard: the host
	// guard refused new Episodes (CPU or scheduler pressure) although packet
	// budget may be left. Draining: every answering node was draining, a
	// planned state and not a capacity shortage. NodeUnavailable: no node
	// answered ready.
	PlacementOverflowNoRoom          PlacementReason = "overflow_no_room"
	PlacementOverflowHostGuard       PlacementReason = "overflow_host_guard"
	PlacementOverflowDraining        PlacementReason = "overflow_draining"
	PlacementOverflowNodeUnavailable PlacementReason = "overflow_node_unavailable"
	// PlacementOverflowNodeProtocol: every node that answered speaks an older wire protocol than
	// this API sends, so none may take an Episode. A binding stores it as
	// PlacementOverflowNodeUnavailable (see Placed); the decision's telemetry and a refusal keep
	// this reason.
	PlacementOverflowNodeProtocol PlacementReason = "overflow_node_protocol_too_old"
	// PlacementNoCapacity keeps the Episode on the first node although no node had
	// room, because the Tenant has no Cloudflare application to take it. The
	// node's admission then refuses the join.
	PlacementNoCapacity PlacementReason = "no_capacity"
)

// ErrPlacementRefused means a new Episode was refused because no own-SFU node had
// room and Cloudflare overflow is off. The wrapping error names the overflow
// placement reason. It is a bounded reason, safe to log.
var ErrPlacementRefused = errors.New("no own sfu node with room (full, draining, host guard closed or not answering) and cloudflare overflow disabled")

// Placement is where a new Episode goes: a node of a provider that runs several,
// or none for a provider with one global endpoint.
type Placement struct {
	Node        string
	Incarnation string
	Reason      PlacementReason
}

func NewBinding(provider Provider, source, applicationID string) (Binding, error) {
	fingerprint, err := AdapterFingerprint(provider, applicationID)
	if err != nil {
		return Binding{}, err
	}
	binding := Binding{SchemaVersion: BindingSchemaVersion, Provider: provider.SettingName(), ConfigurationSource: source, AdapterFingerprint: fingerprint}
	if err := binding.Validate(); err != nil {
		return Binding{}, err
	}
	return binding, nil
}

// Placed records where the Episode goes. The node is not part of the
// fingerprint: it locates the Episode inside the application, it does not pick one.
func (binding Binding) Placed(placement Placement) (Binding, error) {
	binding.Node, binding.NodeIncarnation, binding.PlacementReason = placement.Node, placement.Incarnation, placement.Reason
	if binding.PlacementReason == PlacementOverflowNodeProtocol {
		// The release one step back rejects a reason it does not know, so a rollback would
		// strand this Episode. The node was not usable by this API, which is what unavailable says.
		binding.PlacementReason = PlacementOverflowNodeUnavailable
	}
	if binding.Node != "" && !ValidNodeID(binding.Node) {
		return Binding{}, ErrInvalidBinding
	}
	if err := binding.Validate(); err != nil {
		return Binding{}, err
	}
	return binding, nil
}

// ErrBindingStale means a binding move lost: the stored binding is no longer at the
// generation the mover read, because another API replica moved the Episode first.
var ErrBindingStale = errors.New("episode media plane binding moved to a newer generation")

// ErrRecoveryRefused means a live Episode lost its node and no own-SFU node reserved room for
// it. The Episode never goes to Cloudflare: its binding stays as it was and the caller may
// retry. The wrapping error names a bounded reason.
var ErrRecoveryRefused = errors.New("no own sfu node reserved room for the recovering episode")

// Moved returns the binding of an Episode that recovers onto placement: the next generation,
// the new node and incarnation, and the allocation it leaves remembered for cleanup. A
// placement on a provider without nodes is refused, because a live own-SFU Episode never
// changes provider.
func (binding Binding) Moved(placement Placement) (Binding, error) {
	if binding.Node == "" || placement.Node == "" {
		return Binding{}, ErrInvalidBinding
	}
	previous := binding.PreviousAllocations
	if left := binding.Current(); left != (Allocation{Node: placement.Node, Incarnation: placement.Incarnation}) {
		previous = append(slices.Clone(previous), left)
		if len(previous) > maxPreviousAllocations {
			previous = previous[len(previous)-maxPreviousAllocations:]
		}
	}
	moved, err := binding.Placed(placement)
	if err != nil {
		return Binding{}, err
	}
	moved.Generation, moved.PreviousAllocations = binding.Generation+1, previous
	if err := moved.Validate(); err != nil {
		return Binding{}, err
	}
	return moved, nil
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
func AdapterFingerprint(provider Provider, applicationID string) (string, error) {
	if !validProvider(provider) || applicationID == "" || len(applicationID) > 512 || strings.TrimSpace(applicationID) != applicationID || strings.ContainsRune(applicationID, 0) {
		return "", ErrInvalidBinding
	}
	digest := sha256.Sum256([]byte(provider.SettingName() + "\x00" + applicationID))
	return hex.EncodeToString(digest[:]), nil
}

func (binding Binding) Validate() error {
	if binding.SchemaVersion != BindingSchemaVersion || !KnownSettingName(binding.Provider) {
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
	if binding.Generation < 0 || len(binding.PreviousAllocations) > maxPreviousAllocations || binding.Generation == 0 && len(binding.PreviousAllocations) > 0 {
		return ErrInvalidBinding
	}
	for _, previous := range binding.PreviousAllocations {
		if !ValidNodeID(previous.Node) || previous.Incarnation != "" && !ValidIncarnation(previous.Incarnation) {
			return ErrInvalidBinding
		}
	}
	switch binding.PlacementReason {
	case "", PlacementPrimary, PlacementStandby, PlacementOverflowNoRoom, PlacementOverflowHostGuard, PlacementOverflowDraining, PlacementOverflowNodeUnavailable, PlacementNoCapacity:
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
