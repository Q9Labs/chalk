package tests

// frameBytes is one video frame at kbps and 30 fps.
func frameBytes(kbps int) int { return kbps * 1000 / 8 / 30 }
