#import "ChalkAnnotationPiPContent.h"
#import "ChalkAnnotationPiPPaint.h"

@interface ChalkAnnotationPiPView : UIView
@property(nonatomic, readonly) AVSampleBufferDisplayLayer *display;
@end

@implementation ChalkAnnotationPiPView
+ (Class)layerClass { return AVSampleBufferDisplayLayer.class; }
- (AVSampleBufferDisplayLayer *)display { return (AVSampleBufferDisplayLayer *)self.layer; }
@end

@implementation ChalkAnnotationPiPContent {
  ChalkAnnotationPiPView *_surface;
  CGSize _size;
  NSArray<NSArray *> *_ink;
  UIImage *_background;
  BOOL _dirty;
}

- (instancetype)initWithFrameSize:(CGSize)size {
  if ((self = [super init])) {
    _size = size;
    self.preferredContentSize = size;
    _surface = [[ChalkAnnotationPiPView alloc] initWithFrame:self.view.bounds];
    _surface.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _surface.display.videoGravity = AVLayerVideoGravityResizeAspect;
    // Do not capture the local annotation playback in the outgoing broadcast.
    _surface.display.preventsCapture = YES;
    [self.view addSubview:_surface];
    _dirty = YES;
  }
  return self;
}

- (void)setInk:(NSArray<NSArray *> *)ink {
  _ink = ink;
  _dirty = YES;
}

- (void)setBackgroundImage:(UIImage *)image {
  _background = image;
  _dirty = YES;
}

- (void)stop {
  [_surface.display flushAndRemoveImage];
  [_surface removeFromSuperview];
  _surface = nil;
  _ink = nil;
  _background = nil;
}

- (BOOL)isReadyToDisplay {
  AVSampleBufferDisplayLayer *display = _surface.display;
  if (display.status == AVQueuedSampleBufferRenderingStatusFailed) {
    [display flush];
    _dirty = YES;
  }
  return display.readyForMoreMediaData;
}

- (void)displayNextFrame {
  CMSampleBufferRef sample = [self copyNextSampleBuffer];
  if (!sample) return;
  [_surface.display enqueueSampleBuffer:sample];
  CFRelease(sample);
}

- (CMSampleBufferRef)copyNextSampleBuffer {
  if (!_surface || !_dirty) return NULL;

  CVPixelBufferRef pixels = NULL;
  NSDictionary *attributes = @{(id)kCVPixelBufferIOSurfacePropertiesKey: @{}};
  if (CVPixelBufferCreate(kCFAllocatorDefault, _size.width, _size.height, kCVPixelFormatType_32BGRA,
                          (__bridge CFDictionaryRef)attributes, &pixels) != kCVReturnSuccess) return NULL;
  if (CVPixelBufferLockBaseAddress(pixels, 0) != kCVReturnSuccess) {
    CVPixelBufferRelease(pixels);
    return NULL;
  }

  CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(pixels), _size.width, _size.height, 8,
                                              CVPixelBufferGetBytesPerRow(pixels), rgb,
                                              kCGBitmapByteOrder32Little | (CGBitmapInfo)kCGImageAlphaPremultipliedFirst);
  CGColorSpaceRelease(rgb);
  if (!context) {
    CVPixelBufferUnlockBaseAddress(pixels, 0);
    CVPixelBufferRelease(pixels);
    return NULL;
  }

  CGRect bounds = {CGPointZero, _size};
  CGContextSetRGBFillColor(context, 0.10, 0.11, 0.13, 1);
  CGContextFillRect(context, bounds);
  if (_background) CGContextDrawImage(context, bounds, _background.CGImage);
  CGContextTranslateCTM(context, 0, _size.height);
  CGContextScaleCTM(context, 1, -1);
  ChalkAnnotationPaintPiP(context, _ink);
  CGContextRelease(context);
  CVPixelBufferUnlockBaseAddress(pixels, 0);

  CMSampleBufferRef sample = NULL;
  CMVideoFormatDescriptionRef format = NULL;
  CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixels, &format);
  CMSampleTimingInfo timing = {kCMTimeInvalid, CMClockGetTime(CMClockGetHostTimeClock()), kCMTimeInvalid};
  if (format && CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixels, format, &timing, &sample) == noErr) {
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, true);
    CFMutableDictionaryRef attachment = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
    CFDictionarySetValue(attachment, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
    _dirty = NO;
  }
  if (format) CFRelease(format);
  CVPixelBufferRelease(pixels);
  return sample;
}
@end
