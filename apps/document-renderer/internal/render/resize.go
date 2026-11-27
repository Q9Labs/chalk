package render

import "math"

func ScaledDimensions(width, height, targetEdge int) (int, int) {
	if width <= 0 || height <= 0 {
		return 0, 0
	}
	longest := max(width, height)
	if longest <= targetEdge {
		return width, height
	}
	scale := float64(targetEdge) / float64(longest)
	return max(1, int(math.Round(float64(width)*scale))), max(1, int(math.Round(float64(height)*scale)))
}

// ResizeBGRA is a bounded bilinear resize. Input and output use four bytes per pixel.
func ResizeBGRA(input []byte, width, height, targetEdge int) ([]byte, int, int, error) {
	outWidth, outHeight := ScaledDimensions(width, height, targetEdge)
	if outWidth == 0 || len(input) < width*height*4 {
		return nil, 0, 0, errInvalidResizeInput{}
	}
	if outWidth == width && outHeight == height {
		return append([]byte(nil), input[:width*height*4]...), width, height, nil
	}
	output := make([]byte, outWidth*outHeight*4)
	xRatio := float64(width) / float64(outWidth)
	yRatio := float64(height) / float64(outHeight)
	for y := 0; y < outHeight; y++ {
		sourceY := (float64(y)+0.5)*yRatio - 0.5
		y0 := max(0, int(math.Floor(sourceY)))
		y1 := min(height-1, y0+1)
		yWeight := sourceY - float64(y0)
		if yWeight < 0 {
			yWeight = 0
		}
		for x := 0; x < outWidth; x++ {
			sourceX := (float64(x)+0.5)*xRatio - 0.5
			x0 := max(0, int(math.Floor(sourceX)))
			x1 := min(width-1, x0+1)
			xWeight := sourceX - float64(x0)
			if xWeight < 0 {
				xWeight = 0
			}
			for channel := 0; channel < 4; channel++ {
				a := float64(input[(y0*width+x0)*4+channel])
				b := float64(input[(y0*width+x1)*4+channel])
				c := float64(input[(y1*width+x0)*4+channel])
				d := float64(input[(y1*width+x1)*4+channel])
				top := a + (b-a)*xWeight
				bottom := c + (d-c)*xWeight
				output[(y*outWidth+x)*4+channel] = byte(math.Round(top + (bottom-top)*yWeight))
			}
		}
	}
	return output, outWidth, outHeight, nil
}

type errInvalidResizeInput struct{}

func (errInvalidResizeInput) Error() string { return "invalid resize input" }
