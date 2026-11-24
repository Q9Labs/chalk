#import <AVKit/AVKit.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import "ChalkAnnotationFrameSource.h"
#import "ChalkAnnotationPiPContent.h"

static NSString *const PiPStoppedEvent = @"chalkAnnotationPiPStopped";

static NSString *ChalkPiPErrorDomain(NSError *error) {
  NSString *domain = error.domain;
  if ([domain isEqualToString:AVKitErrorDomain] || [domain isEqualToString:AVFoundationErrorDomain] ||
      [domain isEqualToString:NSOSStatusErrorDomain] || [domain isEqualToString:NSCocoaErrorDomain]) return domain;
  return @"other";
}

static BOOL ChalkPiPValidFrameSize(CGFloat width, CGFloat height) {
  return isfinite(width) && isfinite(height) && width >= 2 && height >= 2 && MAX(width, height) <= 480;
}

@interface ChalkAnnotationPiP : RCTEventEmitter <AVPictureInPictureControllerDelegate>
@end

@implementation ChalkAnnotationPiP {
  NSString *_sessionId;
  AVPictureInPictureController *_controller;
  ChalkAnnotationPiPContent *_content;
  ChalkAnnotationObservation *_observation;
  RTKRTCVideoFrame *_lastFrame;
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

RCT_EXPORT_METHOD(start:(NSString *)sessionId
                  trackId:(NSString *)trackId
                  width:(CGFloat)width
                  height:(CGFloat)height
                  ink:(NSArray<NSArray *> *)ink
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  UIView *source = RCTPresentedViewController().view;
  if (![AVPictureInPictureController isPictureInPictureSupported]) {
    RCTLogWarn(@"chalk.annotation_pip.start_failed reason=unsupported");
    resolve(@NO);
    return;
  }
  if (!ChalkPiPValidFrameSize(width, height)) {
    RCTLogWarn(@"chalk.annotation_pip.start_failed reason=invalid_frame_size");
    resolve(@NO);
    return;
  }
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive || !source.window) {
    RCTLogWarn(@"chalk.annotation_pip.start_failed reason=source_view_unavailable");
    resolve(@NO);
    return;
  }

  [self endSession];
  _sessionId = [sessionId copy];
  CGSize size = CGSizeMake(width, height);
  _content = [[ChalkAnnotationPiPContent alloc] initWithFrameSize:size];
  [_content setInk:ink frameSize:size];

  AVPictureInPictureControllerContentSource *contentSource =
      [[AVPictureInPictureControllerContentSource alloc] initWithActiveVideoCallSourceView:source contentViewController:_content];
  _controller = [[AVPictureInPictureController alloc] initWithContentSource:contentSource];
  if (!_controller) {
    RCTLogWarn(@"chalk.annotation_pip.start_failed reason=controller_unavailable");
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
      if (self->_controller == controller && self->_startResult) {
        RCTLogWarn(@"chalk.annotation_pip.start_failed reason=start_callback_timeout");
        [self endSession];
      }
    });
  } else if (attempts > 0) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      [self startWhenPossible:controller attempts:attempts - 1];
    });
  } else {
    RCTLogWarn(@"chalk.annotation_pip.start_failed reason=video_call_source_not_possible");
    [self endSession];
  }
}

RCT_EXPORT_METHOD(update:(NSString *)sessionId width:(CGFloat)width height:(CGFloat)height ink:(NSArray<NSArray *> *)ink) {
  if (![_sessionId isEqualToString:sessionId] || !ChalkPiPValidFrameSize(width, height)) return;
  [_content setInk:ink frameSize:CGSizeMake(width, height)];
}

RCT_EXPORT_METHOD(stop:(NSString *)sessionId) {
  if ([_sessionId isEqualToString:sessionId]) [self endSession];
}

- (void)pictureInPictureControllerDidStartPictureInPicture:(AVPictureInPictureController *)controller {
  if (_controller != controller || !_startResult) return;
  _launching = NO;
  _startResult(@YES);
  _startResult = nil;
  __weak ChalkAnnotationPiP *weakSelf = self;
  _timer = [NSTimer timerWithTimeInterval:0.1 repeats:YES block:^(__unused NSTimer *timer) { [weakSelf draw]; }];
  [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller failedToStartPictureInPictureWithError:(NSError *)error {
  if (_controller != controller) return;
  RCTLogWarn(@"chalk.annotation_pip.start_failed reason=avkit_error domain=%@ code=%ld", ChalkPiPErrorDomain(error), (long)error.code);
  [self endSession];
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
  NSString *sessionId = _sessionId;
  BOOL notifyStop = _controller && !_startResult && _listening;
  _sessionId = nil;
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
  if (sessionId && notifyStop) [self sendEventWithName:PiPStoppedEvent body:sessionId];
}

- (void)invalidate {
  // The bridge may invalidate off the module queue during a reload.
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_listening = NO;
    [self endSession];
  });
  [super invalidate];
}

- (void)draw {
  if (![_content isReadyToDisplay]) return;
  RTKRTCVideoFrame *frame = _observation.frame;
  if (frame != _lastFrame) {
    _lastFrame = frame;
    [_content setVideoFrame:ChalkAnnotationFrameImage(frame)];
  }
  [_content displayNextFrame];
}
@end
