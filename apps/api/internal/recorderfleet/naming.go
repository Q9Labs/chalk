package recorderfleet

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func EnvironmentTag(environment string) string { return "chalk-environment-" + environment }

func RoleTag(role workeridentity.Role) string { return "chalk-recorder-" + string(role) }

func BootTag(generation uint64) string { return "chalk-boot-" + strconv.FormatUint(generation, 10) }

func ReleaseTag(releaseID string) string { return "chalk-release-" + shortDigest(releaseID) }

func ImageTag(imageDigest string) string {
	return "chalk-image-" + strings.TrimPrefix(imageDigest, "sha256:")
}

func RequiredTags(key PoolKey, ownerTag string, release ReleaseSpec, bootGeneration uint64) []string {
	tags := []string{ownerTag, EnvironmentTag(key.Environment), RoleTag(key.Role), ReleaseTag(release.ReleaseID), ImageTag(release.ImageDigest), BootTag(bootGeneration)}
	slices.Sort(tags)
	return tags
}

func NodeName(key PoolKey, releaseID string, bootGeneration uint64) string {
	return fmt.Sprintf("chalk-recorder-%s-%s-%d-%s", key.Role, key.Environment, bootGeneration, shortDigest(releaseID))
}

func InventoryDigest(node Node) string {
	tags := append([]string(nil), node.Tags...)
	firewalls := append([]string(nil), node.FirewallIDs...)
	slices.Sort(tags)
	slices.Sort(firewalls)
	value := strings.Join([]string{node.ProviderID, node.Name, node.Region, node.Size, strconv.FormatInt(node.ImageID, 10), strconv.FormatUint(node.BootGeneration, 10), strings.Join(tags, ","), strings.Join(firewalls, ",")}, "\x00")
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func validPoolRole(role workeridentity.Role) bool {
	return role == workeridentity.RoleCapture || role == workeridentity.RoleRender
}

func validSlug(value string, maximum int) bool {
	if value == "" || len(value) > maximum || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func validToken(value string, maximum int) bool {
	if value == "" || len(value) > maximum || strings.TrimSpace(value) != value {
		return false
	}
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || strings.ContainsRune("._:-", char) {
			continue
		}
		return false
	}
	return true
}

func validTag(value string) bool { return validToken(value, 255) }

func validDigest(value string) bool {
	if len(value) != len("sha256:")+sha256.Size*2 || !strings.HasPrefix(value, "sha256:") || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return err == nil
}

func validPhase(phase Phase) bool {
	switch phase {
	case PhaseAwaitingBootstrap, PhaseBootstrapping, PhaseReady, PhaseDraining, PhaseIdentityRevoked, PhaseDeleting:
		return true
	default:
		return false
	}
}

func validNodeStatus(status string) bool {
	switch status {
	case "new", "active", "off", "archive":
		return true
	default:
		return false
	}
}

func shortDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:8])
}
