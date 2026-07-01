package regions

type Region struct {
	Code string
	Name string
}

var catalog = []Region{
	{Code: "us", Name: "United States"},
	{Code: "sg", Name: "Singapore"},
}

func Available() []Region {
	regions := make([]Region, len(catalog))
	copy(regions, catalog)
	return regions
}

func Contains(code string) bool {
	for _, region := range catalog {
		if region.Code == code {
			return true
		}
	}

	return false
}
