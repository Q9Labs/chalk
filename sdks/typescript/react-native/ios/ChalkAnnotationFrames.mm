#import "ChalkAnnotationFrameSource.h"
#import <ImageIO/ImageIO.h>
#import <React/RCTEventEmitter.h>

@protocol ChalkWebRTCStreams <NSObject>
@property(nonatomic, readonly) dispatch_queue_t workerQueue;
@property(nonatomic, readonly) NSDictionary<NSString *, RTKRTCMediaStreamTrack *> *localTracks;
- (RTKRTCMediaStream *)streamForReactTag:(NSString *)reactTag;
@end

static NSString *const FrameSizeEvent = @"chalkAnnotationFrameSize";
static const int MaxAnnotationPixels = 4096 * 4096;

CGSize ChalkAnnotationFrameSize(RTKRTCVideoFrame *frame) {
  if (!frame) return CGSizeZero;
  if (frame.rotation == 90 || frame.rotation == 270) return CGSizeMake(frame.height, frame.width);
  return CGSizeMake(frame.width, frame.height);
}

@interface ChalkAnnotationObservation ()
- (RTKRTCVideoFrame *)frameForSize:(CGSize)size;
@end

@implementation ChalkAnnotationObservation
@synthesize frame = _frame;

- (RTKRTCVideoFrame *)frame {
  @synchronized (self) { return _frame; }
}
- (void)setSize:(CGSize)size {}

- (void)renderFrame:(RTKRTCVideoFrame *)frame {
  if (!frame) return;
  @synchronized (self) {
    CGSize size = ChalkAnnotationFrameSize(frame);
    BOOL changed = !CGSizeEqualToSize(ChalkAnnotationFrameSize(_frame), size);
    _frame = frame;
    if (changed && self.onSize) self.onSize(size);
  }
}

- (RTKRTCVideoFrame *)frameForSize:(CGSize)size {
  @synchronized (self) {
    return CGSizeEqualToSize(ChalkAnnotationFrameSize(_frame), size) ? _frame : nil;
  }
}
@end

CIImage *ChalkAnnotationFrameImage(RTKRTCVideoFrame *frame) {
  id<RTKRTCI420Buffer> yuv = [frame.buffer toI420];
  NSInteger width = yuv.width;
  NSInteger height = yuv.height;
  if (width <= 0 || height <= 0 || width * height > MaxAnnotationPixels) return nil;

  CVPixelBufferRef pixelBuffer = NULL;
  if (CVPixelBufferCreate(kCFAllocatorDefault, width, height,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, NULL, &pixelBuffer) != kCVReturnSuccess) return nil;
  if (CVPixelBufferLockBaseAddress(pixelBuffer, 0) != kCVReturnSuccess) {
    CVPixelBufferRelease(pixelBuffer);
    return nil;
  }
  uint8_t *y = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0);
  uint8_t *uv = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1);
  const size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0);
  const size_t uvStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1);
  for (NSInteger row = 0; row < height; row++) {
    memcpy(y + yStride * row, yuv.dataY + yuv.strideY * row, width);
  }
  for (NSInteger row = 0; row < yuv.chromaHeight; row++) {
    for (NSInteger column = 0; column < yuv.chromaWidth; column++) {
      uv[uvStride * row + 2 * column] = yuv.dataU[yuv.strideU * row + column];
      uv[uvStride * row + 2 * column + 1] = yuv.dataV[yuv.strideV * row + column];
    }
  }
  CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);

  CIImage *image = [CIImage imageWithCVPixelBuffer:pixelBuffer];
  CVPixelBufferRelease(pixelBuffer);
  if (frame.rotation == 90) image = [image imageByApplyingOrientation:kCGImagePropertyOrientationRight];
  if (frame.rotation == 180) image = [image imageByApplyingOrientation:kCGImagePropertyOrientationDown];
  if (frame.rotation == 270) image = [image imageByApplyingOrientation:kCGImagePropertyOrientationLeft];
  return image;
}

static NSURL *WriteAnnotationFrame(RTKRTCVideoFrame *frame) {
  CIImage *image = ChalkAnnotationFrameImage(frame);
  if (!image) return nil;
  NSURL *directory = [[NSFileManager defaultManager] URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask].firstObject;
  NSString *name = [NSString stringWithFormat:@"chalk-annotation-%@.png", NSUUID.UUID.UUIDString];
  NSURL *url = [directory URLByAppendingPathComponent:name];
  CIContext *context = [CIContext contextWithOptions:nil];
  CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  BOOL saved = [context writePNGRepresentationOfImage:image toURL:url format:kCIFormatRGBA8 colorSpace:color options:@{} error:NULL];
  CGColorSpaceRelease(color);
  return saved ? url : nil;
}

void ChalkFindAnnotationTrack(RCTBridge *bridge, NSString *streamUrl, void (^completion)(RTKRTCVideoTrack *track)) {
  id<ChalkWebRTCStreams> module = (id)[bridge moduleForName:@"WebRTCModule"];
  if (!module.workerQueue) return;
  dispatch_async(module.workerQueue, ^{
    RTKRTCVideoTrack *track = [module streamForReactTag:streamUrl].videoTracks.firstObject;
    dispatch_async(dispatch_get_main_queue(), ^{ completion(track); });
  });
}

void ChalkFindLocalAnnotationTrack(RCTBridge *bridge, NSString *trackId, void (^completion)(RTKRTCVideoTrack *track)) {
  id<ChalkWebRTCStreams> module = (id)[bridge moduleForName:@"WebRTCModule"];
  if (!module.workerQueue) return;
  dispatch_async(module.workerQueue, ^{
    RTKRTCMediaStreamTrack *track = module.localTracks[trackId];
    if (![track isKindOfClass:RTKRTCVideoTrack.class]) return;
    dispatch_async(dispatch_get_main_queue(), ^{ completion((RTKRTCVideoTrack *)track); });
  });
}

@interface ChalkAnnotationFrames : RCTEventEmitter <RCTBridgeModule>
@end

@implementation ChalkAnnotationFrames {
  NSMutableDictionary<NSString *, ChalkAnnotationObservation *> *_observers;
  BOOL _encoding;
  BOOL _sampling;
}

RCT_EXPORT_MODULE(ChalkAnnotationFrames)

+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[FrameSizeEvent]; }

RCT_EXPORT_METHOD(observe:(NSString *)key streamUrl:(NSString *)streamUrl) {
  [self stopObserving:key];
  ChalkAnnotationObservation *observer = [ChalkAnnotationObservation new];
  if (!_observers) _observers = [NSMutableDictionary new];
  _observers[key] = observer;
  __weak ChalkAnnotationFrames *weakSelf = self;
  __weak ChalkAnnotationObservation *weakObserver = observer;
  observer.onSize = ^(CGSize size) {
    dispatch_async(dispatch_get_main_queue(), ^{
      ChalkAnnotationFrames *strongSelf = weakSelf;
      ChalkAnnotationObservation *live = weakObserver;
      if (!strongSelf || !live || strongSelf->_observers[key] != live) return;
      [strongSelf sendEventWithName:FrameSizeEvent body:@{ @"key": key, @"width": @(size.width), @"height": @(size.height) }];
    });
  };

  ChalkFindAnnotationTrack(self.bridge, streamUrl, ^(RTKRTCVideoTrack *track) {
    if (self->_observers[key] != observer || !track) return;
    observer.track = track;
    [track addRenderer:observer];
  });
}

RCT_EXPORT_METHOD(stop:(NSString *)key) {
  [self stopObserving:key];
}

- (void)stopObserving:(NSString *)key {
  ChalkAnnotationObservation *observer = _observers[key];
  [_observers removeObjectForKey:key];
  [observer.track removeRenderer:observer];
  observer.track = nil;
}

RCT_EXPORT_METHOD(capture:(NSString *)key
                  width:(double)width
                  height:(double)height
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  RTKRTCVideoFrame *frame = [_observers[key] frameForSize:CGSizeMake(width, height)];
  if (!frame || _encoding) {
    resolve(nil);
    return;
  }
  _encoding = YES;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSURL *url = WriteAnnotationFrame(frame);
    dispatch_async(dispatch_get_main_queue(), ^{
      self->_encoding = NO;
      if (url) resolve(url.absoluteString);
      else reject(@"annotation_frame_capture", @"Unable to encode the shared frame.", nil);
    });
  });
}

// A decoded sample can prove an export on iOS, but never retires displayed ink.
RCT_EXPORT_METHOD(sample:(NSString *)key
                  width:(double)width
                  height:(double)height
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
  RTKRTCVideoFrame *frame = [_observers[key] frameForSize:CGSizeMake(width, height)];
  if (!frame || _sampling) {
    resolve(nil);
    return;
  }
  _sampling = YES;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    CIImage *image = ChalkAnnotationFrameImage(frame);
    NSData *png = nil;
    if (image) {
      CGFloat scale = MIN(1, 272 / MAX(image.extent.size.width, image.extent.size.height));
      CIImage *sample = [image imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
      CIContext *context = [CIContext contextWithOptions:nil];
      CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
      png = [context PNGRepresentationOfImage:sample format:kCIFormatRGBA8 colorSpace:color options:@{}];
      CGColorSpaceRelease(color);
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      self->_sampling = NO;
      resolve([png base64EncodedStringWithOptions:0]);
    });
  });
}

- (void)invalidate {
  [super invalidate];
  dispatch_async(dispatch_get_main_queue(), ^{
    for (NSString *key in self->_observers.allKeys) [self stopObserving:key];
  });
}
@end
