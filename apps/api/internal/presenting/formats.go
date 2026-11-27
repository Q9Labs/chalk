package presenting

type FormatFlags struct {
	Office  bool
	Keynote bool
}

func (f FormatFlags) allows(flag FormatFlag) bool {
	switch flag {
	case FormatFlagCore:
		return true
	case FormatFlagOffice:
		return f.Office
	case FormatFlagKeynote:
		return f.Office && f.Keynote
	default:
		return false
	}
}

func (f FormatFlags) AcceptsMIMEType(mimeType string) bool {
	for _, format := range Formats {
		if !f.allows(format.Flag) {
			continue
		}
		for _, accepted := range format.MIMETypes {
			if accepted == mimeType {
				return true
			}
		}
	}
	return false
}

func (f FormatFlags) AcceptedFormatIDs() []string {
	ids := make([]string, 0, len(Formats))
	for _, format := range Formats {
		if f.allows(format.Flag) {
			ids = append(ids, format.ID)
		}
	}
	return ids
}

func FailureMessage(code, fallback string) string {
	for _, reason := range FailureReasons {
		if reason.Code == code {
			return reason.Message
		}
	}
	return fallback
}
