package office

type Format struct {
	Extension   string
	Container   Container
	Spreadsheet bool
	Keynote     bool
}

type Container int

const (
	ContainerText Container = iota
	ContainerOOXML
	ContainerLegacy
	ContainerODF
	ContainerZip
)

var formats = map[string]Format{
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": {Extension: "pptx", Container: ContainerOOXML},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   {Extension: "docx", Container: ContainerOOXML},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         {Extension: "xlsx", Container: ContainerOOXML, Spreadsheet: true},
	"application/vnd.ms-powerpoint":                                             {Extension: "ppt", Container: ContainerLegacy},
	"application/msword":                                                        {Extension: "doc", Container: ContainerLegacy},
	"application/vnd.ms-excel":                                                  {Extension: "xls", Container: ContainerLegacy, Spreadsheet: true},
	"application/vnd.oasis.opendocument.presentation":                           {Extension: "odp", Container: ContainerODF},
	"application/vnd.oasis.opendocument.text":                                   {Extension: "odt", Container: ContainerODF},
	"application/vnd.oasis.opendocument.spreadsheet":                            {Extension: "ods", Container: ContainerODF, Spreadsheet: true},
	"text/plain":                         {Extension: "txt", Container: ContainerText},
	"application/vnd.apple.keynote":      {Extension: "key", Container: ContainerZip, Keynote: true},
	"application/x-iwork-keynote-sffkey": {Extension: "key", Container: ContainerZip, Keynote: true},
}

func Lookup(mimeType string) (Format, bool) {
	format, ok := formats[mimeType]
	return format, ok
}

func MIMETypes() []string {
	types := make([]string, 0, len(formats))
	for mimeType := range formats {
		types = append(types, mimeType)
	}
	return types
}
