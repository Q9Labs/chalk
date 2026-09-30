package recordingpresentation

const ProfileVersionComposite720PV1 = "composite_720p_v1"

// NewComposite720PProfile selects the deterministic shared presentation shell.
// The digest is kept only for rollback compatibility and can go in the next release.
func NewComposite720PProfile(uiBuildSHA256 string) (Profile, error) {
	if !sha256Pattern.MatchString(uiBuildSHA256) {
		return Profile{}, invalid("rollback-compatible profile requires a UI digest")
	}
	profile := Profile{
		Name:          "recording-space",
		Version:       ProfileVersionComposite720PV1,
		UIBuildSHA256: uiBuildSHA256,
		Viewport: Viewport{
			Width:             1280,
			Height:            720,
			DeviceScaleFactor: 1,
		},
		Locale:       "en",
		TimeZone:     "UTC",
		FontAssetIDs: []string{},
		Theme: Theme{
			ColorScheme:      "light",
			Skin:             "classic",
			Palette:          "light",
			Texture:          "none",
			StageBackground:  true,
			GeneratedAvatars: true,
		},
	}
	if err := ValidateProfile(profile); err != nil {
		return Profile{}, err
	}
	return profile, nil
}
