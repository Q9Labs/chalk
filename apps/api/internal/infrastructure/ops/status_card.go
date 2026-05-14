package ops

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"strings"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"golang.org/x/image/font"
	"golang.org/x/image/font/inconsolata"
	"golang.org/x/image/math/fixed"
)

const (
	statusCardWidth  = 1200
	statusCardHeight = 630
)

var (
	// Premium dark palette - high contrast
	bgPrimary    = rgba(3, 7, 18)   // Deep navy/black
	bgElevated   = rgba(15, 23, 42) // Elevated surfaces
	bgPanel      = rgba(30, 41, 59) // Component panels
	borderSubtle = rgba(51, 65, 85) // Subtle borders

	// Text colors - high contrast
	textPrimary   = rgba(248, 250, 252) // Almost white
	textSecondary = rgba(203, 213, 225) // Light gray
	textMuted     = rgba(148, 163, 184) // Muted gray

	// Status colors - vibrant
	statusGood    = rgba(34, 197, 94)  // Emerald 500
	statusWarning = rgba(245, 158, 11) // Amber 500
	statusBad     = rgba(239, 68, 68)  // Red 500
	statusInfo    = rgba(59, 130, 246) // Blue 500
)

func BuildPublicStatusCardPNG(summary PublicStatusSummary) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, statusCardWidth, statusCardHeight))

	// Fill background with subtle gradient effect using diagonal lines
	draw.Draw(img, img.Bounds(), image.NewUniform(bgPrimary), image.Point{}, draw.Src)

	// Add subtle texture/grid pattern
	drawGridPattern(img, bgElevated)

	// Status color based on overall state
	statusColor := statusCardColorForState(summary.Overall)

	// Top accent bar - brand signature
	fillRect(img, 0, 0, statusCardWidth, 6, statusColor)

	// Main content layout
	marginX := 72
	contentTop := 64

	// Header section with logo area and timestamp
	drawHeader(img, marginX, contentTop, summary.GeneratedAt)

	// Main status hero section
	heroY := 140
	drawStatusHero(img, marginX, heroY, summary, statusColor)

	// Components section
	componentsY := 340
	drawComponentsSection(img, marginX, componentsY, summary.Components, statusColor)

	// Footer
	drawFooter(img, marginX, statusCardHeight-48, summary)

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func drawHeader(img *image.RGBA, x, y int, generatedAt time.Time) {
	// Logo/Brand - "chalk" in bold
	brandFace := inconsolata.Bold8x16
	drawTextScaled(img, brandFace, x, y, textPrimary, "chalk", 3.5)

	// Status label next to brand
	labelX := x + 140
	drawTextScaled(img, inconsolata.Regular8x16, labelX, y+8, textMuted, "STATUS", 1.2)

	// Timestamp on right side
	timeStr := formatStatusCardTime(generatedAt)
	timeX := statusCardWidth - 72
	drawTextRightScaled(img, inconsolata.Regular8x16, timeX, y+8, textMuted, timeStr, 1.2)
}

func drawStatusHero(img *image.RGBA, x, y int, summary PublicStatusSummary, statusColor color.RGBA) {
	// Status indicator dot
	dotRadius := 12
	dotCenterX := x + dotRadius
	dotCenterY := y + 24
	fillCircle(img, dotCenterX, dotCenterY, dotRadius, statusColor)

	// Glow effect around dot
	for r := dotRadius + 1; r <= dotRadius+8; r++ {
		alpha := 0.15 - float64(r-dotRadius)*0.015
		glowColor := blendColor(statusColor, bgPrimary, alpha)
		strokeCircle(img, dotCenterX, dotCenterY, r, glowColor, 1)
	}

	// Status headline
	headlineX := x + 40
	headlineY := y + 32
	headline := statusCardHeadline(summary)
	drawTextScaled(img, inconsolata.Bold8x16, headlineX, headlineY, textPrimary, headline, 2.8)

	// Detail text
	detailY := headlineY + 52
	detail := statusCardDetail(summary)
	drawWrappedTextScaled(img, inconsolata.Regular8x16, x, detailY, statusCardWidth-(x*2), 36, textSecondary, detail, 2, 1.6)
}

func drawComponentsSection(img *image.RGBA, x, y int, components []PublicComponentStatus, overallStatus color.RGBA) {
	// Section label
	labelY := y
	drawTextScaled(img, inconsolata.Regular8x16, x, labelY, textMuted, "SYSTEM COMPONENTS", 1.2)

	// Component cards - horizontal layout
	cardY := labelY + 36
	cardHeight := 110
	cardGap := 20
	maxCards := 3
	availableWidth := statusCardWidth - (x * 2)
	cardWidth := (availableWidth - (cardGap * (maxCards - 1))) / maxCards

	for i, component := range components {
		if i >= maxCards {
			break
		}

		cardX := x + (i * (cardWidth + cardGap))
		stateColor := statusCardColorForState(component.State)

		// Card background with subtle border
		roundRect(img, cardX, cardY, cardX+cardWidth, cardY+cardHeight, 8, bgPanel)
		strokeRoundRect(img, cardX, cardY, cardX+cardWidth, cardY+cardHeight, 8, borderSubtle, 1)

		// Status indicator strip at top of card
		stripHeight := 4
		fillRect(img, cardX, cardY, cardX+cardWidth, cardY+stripHeight, stateColor)

		// Component name
		textX := cardX + 20
		textY := cardY + 36
		drawTextScaled(img, inconsolata.Bold8x16, textX, textY, textPrimary, truncateString(component.Name, 16), 1.5)

		// State label
		stateY := textY + 28
		stateText := strings.ToUpper(string(component.State))
		drawTextScaled(img, inconsolata.Regular8x16, textX, stateY, stateColor, stateText, 1.1)

		// Uptime percentage at bottom
		uptimeY := cardY + cardHeight - 16
		var uptimeText string
		if component.RecentUptimePct != nil {
			uptimeText = fmt.Sprintf("%.1f%% uptime", *component.RecentUptimePct)
		} else {
			uptimeText = "Live monitoring"
		}
		drawTextScaled(img, inconsolata.Regular8x16, textX, uptimeY, textMuted, uptimeText, 1.0)
	}

	// If more components than shown
	if len(components) > maxCards {
		moreY := cardY + cardHeight + 16
		moreText := fmt.Sprintf("+ %d more components", len(components)-maxCards)
		drawTextScaled(img, inconsolata.Regular8x16, x, moreY, textMuted, moreText, 1.1)
	}
}

func drawFooter(img *image.RGBA, x, y int, summary PublicStatusSummary) {
	// Divider line
	lineY := y - 16
	fillRect(img, x, lineY, statusCardWidth-x, lineY+1, borderSubtle)

	// URL on left
	drawTextScaled(img, inconsolata.Regular8x16, x, y, textMuted, "chalkmeet.com/status", 1.1)

	// Status summary on right
	var summaryText string
	switch {
	case len(summary.ActiveIncidents) > 0:
		if len(summary.ActiveIncidents) == 1 {
			summaryText = "1 active incident"
		} else {
			summaryText = fmt.Sprintf("%d active incidents", len(summary.ActiveIncidents))
		}
	case len(summary.Maintenance) > 0:
		if len(summary.Maintenance) == 1 {
			summaryText = "1 maintenance window"
		} else {
			summaryText = fmt.Sprintf("%d maintenance windows", len(summary.Maintenance))
		}
	default:
		summaryText = "All systems operational"
	}

	summaryX := statusCardWidth - x
	drawTextRightScaled(img, inconsolata.Regular8x16, summaryX, y, statusCardColorForState(summary.Overall), summaryText, 1.1)
}

func drawGridPattern(img *image.RGBA, c color.RGBA) {
	// Subtle dot grid pattern
	spacing := 40
	dotSize := 1
	for x := spacing; x < statusCardWidth; x += spacing {
		for y := spacing; y < statusCardHeight; y += spacing {
			fillRect(img, x, y, x+dotSize, y+dotSize, c)
		}
	}
}

func statusCardHeadline(summary PublicStatusSummary) string {
	switch summary.Overall {
	case domainops.ComponentStateOutage:
		if len(summary.ActiveIncidents) > 0 {
			return "Service Outage"
		}
		return "Major Outage"
	case domainops.ComponentStateDegraded:
		return "Degraded Performance"
	case domainops.ComponentStateMaintenance:
		return "Maintenance in Progress"
	default:
		return "All Systems Operational"
	}
}

func statusCardDetail(summary PublicStatusSummary) string {
	if len(summary.ActiveIncidents) > 0 {
		top := summary.ActiveIncidents[0]
		message := firstNonEmpty(deref(top.PublicMessage), deref(top.Summary), top.Title)
		// Active incidents don't have an end time yet, show affected components count instead
		if len(top.ComponentIds) > 0 {
			if len(top.ComponentIds) == 1 {
				return fmt.Sprintf("%s (1 component affected)", message)
			}
			return fmt.Sprintf("%s (%d components affected)", message, len(top.ComponentIds))
		}
		return message
	}
	if len(summary.Maintenance) > 0 {
		top := summary.Maintenance[0]
		window := firstNonEmpty(deref(top.PublicMessage), deref(top.Summary), top.Title)
		if !top.EndsAt.IsZero() {
			return fmt.Sprintf("%s — Expected completion: %s", strings.TrimSpace(window), formatStatusCardTime(top.EndsAt))
		}
		return window
	}
	switch summary.Overall {
	case domainops.ComponentStateOutage:
		return "We are actively working to restore full service."
	case domainops.ComponentStateDegraded:
		return "Some users may experience slower response times."
	case domainops.ComponentStateMaintenance:
		return "Scheduled maintenance is currently underway."
	default:
		return "All services are running normally. No incidents reported."
	}
}

func statusCardColorForState(state domainops.ComponentState) color.RGBA {
	switch state {
	case domainops.ComponentStateOutage:
		return statusBad
	case domainops.ComponentStateDegraded:
		return statusWarning
	case domainops.ComponentStateMaintenance:
		return statusInfo
	default:
		return statusGood
	}
}

func formatStatusCardTime(ts time.Time) string {
	if ts.IsZero() {
		return "now"
	}
	return ts.UTC().Format("Jan 2, 15:04 UTC")
}

// Drawing utilities

func fillRect(img *image.RGBA, x1, y1, x2, y2 int, c color.RGBA) {
	r := image.Rect(x1, y1, x2, y2).Intersect(img.Bounds())
	if r.Empty() {
		return
	}
	draw.Draw(img, r, image.NewUniform(c), image.Point{}, draw.Src)
}

func fillCircle(img *image.RGBA, centerX, centerY, radius int, c color.RGBA) {
	for y := -radius; y <= radius; y++ {
		for x := -radius; x <= radius; x++ {
			if x*x+y*y <= radius*radius {
				img.Set(centerX+x, centerY+y, c)
			}
		}
	}
}

func strokeCircle(img *image.RGBA, centerX, centerY, radius int, c color.RGBA, thickness int) {
	rSquared := radius * radius
	innerRSquared := (radius - thickness) * (radius - thickness)
	for y := -radius; y <= radius; y++ {
		for x := -radius; x <= radius; x++ {
			distSq := x*x + y*y
			if distSq <= rSquared && distSq >= innerRSquared {
				img.Set(centerX+x, centerY+y, c)
			}
		}
	}
}

func roundRect(img *image.RGBA, x1, y1, x2, y2, radius int, c color.RGBA) {
	// Fill main rectangle
	fillRect(img, x1+radius, y1, x2-radius, y2, c)
	fillRect(img, x1, y1+radius, x2, y2-radius, c)

	// Fill corners
	fillCircleQuarter(img, x1+radius, y1+radius, radius, 2, c) // top-left
	fillCircleQuarter(img, x2-radius, y1+radius, radius, 1, c) // top-right
	fillCircleQuarter(img, x1+radius, y2-radius, radius, 3, c) // bottom-left
	fillCircleQuarter(img, x2-radius, y2-radius, radius, 0, c) // bottom-right
}

func strokeRoundRect(img *image.RGBA, x1, y1, x2, y2, radius int, c color.RGBA, thickness int) {
	// Draw lines
	fillRect(img, x1+radius, y1, x2-radius, y1+thickness, c) // top
	fillRect(img, x1+radius, y2-thickness, x2-radius, y2, c) // bottom
	fillRect(img, x1, y1+radius, x1+thickness, y2-radius, c) // left
	fillRect(img, x2-thickness, y1+radius, x2, y2-radius, c) // right
}

func fillCircleQuarter(img *image.RGBA, centerX, centerY, radius, quadrant int, c color.RGBA) {
	// quadrant: 0=bottom-right, 1=top-right, 2=top-left, 3=bottom-left
	for y := 0; y <= radius; y++ {
		for x := 0; x <= radius; x++ {
			if x*x+y*y <= radius*radius {
				switch quadrant {
				case 0:
					img.Set(centerX+x, centerY+y, c)
				case 1:
					img.Set(centerX+x, centerY-y, c)
				case 2:
					img.Set(centerX-x, centerY-y, c)
				case 3:
					img.Set(centerX-x, centerY+y, c)
				}
			}
		}
	}
}

func drawTextScaled(img *image.RGBA, face font.Face, x, y int, c color.RGBA, text string, scale float64) {
	if scale == 1.0 {
		drawText(img, face, x, y, c, text)
		return
	}

	// For scaling, we draw to a temporary image and scale
	tempWidth := int(float64(len(text)*16) * scale)
	tempHeight := int(32 * scale)
	tempImg := image.NewRGBA(image.Rect(0, 0, tempWidth, tempHeight))

	d := &font.Drawer{
		Dst:  tempImg,
		Src:  image.NewUniform(c),
		Face: face,
		Dot:  fixed.P(0, int(16*scale)),
	}
	d.DrawString(text)

	// Scale and copy to main image
	for py := 0; py < tempHeight && y+py-int(16*scale) < statusCardHeight; py++ {
		for px := 0; px < tempWidth && x+px < statusCardWidth; px++ {
			srcColor := tempImg.At(px, py)
			if _, _, _, a := srcColor.RGBA(); a > 0 {
				img.Set(x+px, y+py-int(16*scale)+int(16*scale), srcColor)
			}
		}
	}
}

func drawText(img *image.RGBA, face font.Face, x, y int, c color.RGBA, text string) {
	d := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(c),
		Face: face,
		Dot:  fixed.P(x, y),
	}
	d.DrawString(text)
}

func drawTextRightScaled(img *image.RGBA, face font.Face, x, y int, c color.RGBA, text string, scale float64) {
	// Measure text width
	d := &font.Drawer{Face: face}
	width := d.MeasureString(text).Round()
	scaledWidth := int(float64(width) * scale)
	drawTextScaled(img, face, x-scaledWidth, y, c, text, scale)
}

func drawWrappedTextScaled(img *image.RGBA, face font.Face, x, y, maxWidth, lineHeight int, c color.RGBA, text string, maxLines int, scale float64) {
	if strings.TrimSpace(text) == "" {
		return
	}
	words := strings.Fields(text)
	if len(words) == 0 {
		return
	}

	scaledMaxWidth := int(float64(maxWidth) / scale)
	lines := make([]string, 0, maxLines)
	current := words[0]
	measure := &font.Drawer{Face: face}

	for _, word := range words[1:] {
		candidate := current + " " + word
		if measure.MeasureString(candidate).Round() <= scaledMaxWidth {
			current = candidate
			continue
		}
		lines = append(lines, current)
		current = word
		if len(lines) == maxLines-1 {
			break
		}
	}
	if len(lines) < maxLines {
		lines = append(lines, current)
	}
	if len(lines) == maxLines && len(words) > 0 {
		last := lines[len(lines)-1]
		for measure.MeasureString(last+"...").Round() > scaledMaxWidth && len(last) > 0 {
			last = strings.TrimSpace(last[:len(last)-1])
		}
		lines[len(lines)-1] = last + "..."
	}

	scaledLineHeight := int(float64(lineHeight) * scale)
	for i, line := range lines {
		drawTextScaled(img, face, x, y+(i*scaledLineHeight), c, line, scale)
	}
}

func blendColor(fg, bg color.RGBA, alpha float64) color.RGBA {
	clamp := func(v float64) float64 {
		if v < 0 {
			return 0
		}
		if v > 1 {
			return 1
		}
		return v
	}
	a := clamp(alpha)
	return color.RGBA{
		R: uint8((float64(fg.R) * a) + (float64(bg.R) * (1 - a))),
		G: uint8((float64(fg.G) * a) + (float64(bg.G) * (1 - a))),
		B: uint8((float64(fg.B) * a) + (float64(bg.B) * (1 - a))),
		A: 255,
	}
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

func rgba(r, g, b uint8) color.RGBA {
	return color.RGBA{R: r, G: g, B: b, A: 255}
}
