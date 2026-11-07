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

// OnNode places the binding on one provider node. The node is not part of the
// fingerprint: it locates the Episode inside the application, it does not pick one.
func (binding Binding) OnNode(node string) (Binding, error) {
	binding.Node = node
	if !ValidNodeID(node) {
		return Binding{}, ErrInvalidBinding
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
	return nil
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
