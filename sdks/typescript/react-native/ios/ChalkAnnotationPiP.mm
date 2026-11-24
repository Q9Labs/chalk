#import <AVKit/AVKit.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>
#import "ChalkAnnotationFrameSource.h"
#import "ChalkAnnotationPiPContent.h"

static NSString *const PiPStoppedEvent = @"chalkAnnotationPiPStopped";

@interface ChalkAnnotationPiP : RCTEventEmitter <AVPictureInPictureControllerDelegate>
@end

@implementation ChalkAnnotationPiP {
  NSString *_publication;
  AVPictureInPictureController *_controller;
  ChalkAnnotationPiPContent *_content;
  ChalkAnnotationObservation *_observation;
  RTKRTCVideoFrame *_lastFrame;
  CIContext *_imageContext;
  CGSize _size;
  NSTimer *_timer;
  RCTPromiseResolveBlock _startResult;
  BOOL _launching;
  BOOL _listening;
}

RCT_EXPORT_MODULE(ChalkAnnotationPiP)

+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[PiPStoppedEvent]; }
- (void)startObserving { _listening = YES; }
- (void)stopObserving { _listening = NO; }

RCT_EXPORT_METHOD(supported:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@([AVPictureInPictureController isPictureInPictureSupported]));
}

RCT_EXPORT_METHOD(start:(NSString *)publication
                  trackId:(NSString *)trackId
                  width:(CGFloat)width
                  height:(CGFloat)height
                  ink:(NSArray<NSArray *> *)ink
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  UIView *source = RCTPresentedViewController().view;
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive || !source.window ||
      ![AVPictureInPictureController isPictureInPictureSupported] ||
      !isfinite(width) || !isfinite(height) || width < 2 || height < 2 || MAX(width, height) > 480) {
    resolve(@NO);
    return;
  }

  [self endSession];
  _publication = [publication copy];
  _size = CGSizeMake(width, height);
  _content = [[ChalkAnnotationPiPContent alloc] initWithFrameSize:_size];
  [_content setInk:ink];

  AVPictureInPictureControllerContentSource *contentSource =
      [[AVPictureInPictureControllerContentSource alloc] initWithActiveVideoCallSourceView:source contentViewController:_content];
  _controller = [[AVPictureInPictureController alloc] initWithContentSource:contentSource];
  if (!_controller) {
    [self endSession];
    resolve(@NO);
    return;
  }
  _controller.delegate = self;
  _startResult = resolve;

  if (trackId.length > 0) {
    ChalkAnnotationObservation *observation = [ChalkAnnotationObservation new];
    _observation = observation;
    ChalkFindLocalAnnotationTrack(self.bridge, trackId, ^(RTKRTCVideoTrack *track) {
      if (self->_observation != observation || !track) return;
      observation.track = track;
      [track addRenderer:observation];
    });
  }
  [self draw];
  [self startWhenPossible:_controller attempts:20];
}

- (void)startWhenPossible:(AVPictureInPictureController *)controller attempts:(NSUInteger)attempts {
  if (_controller != controller || !_startResult || _launching) return;
  if (controller.isPictureInPicturePossible) {
    _launching = YES;
    [controller startPictureInPicture];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      if (self->_controller == controller && self->_startResult) [self endSession];
    });
  } else if (attempts > 0) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      [self startWhenPossible:controller attempts:attempts - 1];
    });
  } else {
    [self endSession];
  }
}

RCT_EXPORT_METHOD(update:(NSString *)publication ink:(NSArray<NSArray *> *)ink) {
  if (![_publication isEqualToString:publication]) return;
  [_content setInk:ink];
}

RCT_EXPORT_METHOD(stop:(NSString *)publication) {
  if ([_publication isEqualToString:publication]) [self endSession];
}

- (void)pictureInPictureControllerDidStartPictureInPicture:(AVPictureInPictureController *)controller {
  if (_controller != controller) return;
  _launching = NO;
  _startResult(@YES);
  _startResult = nil;
  __weak ChalkAnnotationPiP *weakSelf = self;
  _timer = [NSTimer timerWithTimeInterval:0.1 repeats:YES block:^(__unused NSTimer *timer) { [weakSelf draw]; }];
  [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller failedToStartPictureInPictureWithError:(NSError *)error {
  if (_controller == controller) [self endSession];
}

- (void)pictureInPictureControllerDidStopPictureInPicture:(AVPictureInPictureController *)controller {
  if (_controller == controller) [self endSession];
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler:(void (^)(BOOL restored))completion {
  // The call remains mounted throughout PiP, so there is nothing to navigate back to.
  completion(_controller == controller && RCTPresentedViewController().view.window != nil);
}

- (void)endSession {
  NSString *publication = _publication;
  _publication = nil;
  [_timer invalidate];
  _timer = nil;
  if (_startResult) _startResult(@NO);
  _startResult = nil;
  if (_controller.isPictureInPictureActive || _launching) [_controller stopPictureInPicture];
  _controller.delegate = nil;
  _controller.contentSource = nil;
  _controller = nil;
  _launching = NO;
  [_content stop];
  _content = nil;
  [_observation.track removeRenderer:_observation];
  _observation = nil;
  _lastFrame = nil;
  if (publication && _listening) [self sendEventWithName:PiPStoppedEvent body:publication];
}

- (void)invalidate {
  // The bridge may invalidate off the module queue during a reload.
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_listening = NO;
    [self endSession];
  });
  [super invalidate];
}

- (UIImage *)backgroundImageForFrame:(RTKRTCVideoFrame *)frame {
  CGSize frameSize = ChalkAnnotationFrameSize(frame);
  // Don't place old normalized coordinates over a rotated frame.
  if (frameSize.height <= 0 || fabs(frameSize.width / frameSize.height - _size.width / _size.height) > 0.015) return nil;
  CIImage *image = ChalkAnnotationFrameImage(frame);
  if (!image) return nil;
  if (!_imageContext) _imageContext = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @YES}];
  image = [image imageByApplyingTransform:CGAffineTransformMakeScale(_size.width / image.extent.size.width, _size.height / image.extent.size.height)];
  CGImageRef scaled = [_imageContext createCGImage:image fromRect:image.extent];
  if (!scaled) return nil;
  UIImage *background = [UIImage imageWithCGImage:scaled];
  CGImageRelease(scaled);
  return background;
}

- (void)draw {
  if (![_content isReadyToDisplay]) return;
  RTKRTCVideoFrame *frame = _observation.frame;
  if (frame != _lastFrame) {
    _lastFrame = frame;
    [_content setBackgroundImage:[self backgroundImageForFrame:frame]];
  }
  [_content displayNextFrame];
}
@end
