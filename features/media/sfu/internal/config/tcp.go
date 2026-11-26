package config

// tcpAddrs reads the plural listener setting, with SFU_TCP_ADDR as the single-listener form
// existing local runs and older release binaries use.
func tcpAddrs(r reader) []string {
	if addrs := r.list("SFU_TCP_ADDRS"); len(addrs) > 0 {
		return addrs
	}
	if legacy := r.text("SFU_TCP_ADDR", ""); legacy != "" {
		return []string{legacy}
	}
	return nil
}
