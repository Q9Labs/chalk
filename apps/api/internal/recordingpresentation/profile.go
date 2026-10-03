package recordingpresentation

const ProfileVersionComposite720PV1 = "composite_720p_v1"

// NewComposite720PProfile selects the deterministic shared presentation shell.
func NewComposite720PProfile() (Profile, error) {
	profile := Profile{
		Name:    "recording-space",
		Version: ProfileVersionComposite720PV1,
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
