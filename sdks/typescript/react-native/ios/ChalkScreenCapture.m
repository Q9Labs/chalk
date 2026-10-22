#import <React/RCTBridge.h>
#import <React/RCTBridgeModule.h>
#import <ReplayKit/ReplayKit.h>
#import <react-native-webrtc/WebRTCModule.h>

@interface ChalkScreenCapture : NSObject <RCTBridgeModule, RTKRTCVideoRenderer>
@property(nonatomic, weak) RCTBridge *bridge;
@property(nonatomic, strong) RTKRTCVideoTrack *track;
@property(nonatomic, strong) RPSystemBroadcastPickerView *picker;
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@property(nonatomic) NSUInteger generation;
@end

@implementation ChalkScreenCapture
RCT_EXPORT_MODULE();
@synthesize bridge = _bridge;

+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (void)finishWithError:(NSString *)message {
    RCTPromiseResolveBlock resolve = self.resolve;
    RCTPromiseRejectBlock reject = self.reject;
    self.resolve = nil;
    self.reject = nil;
    [self.picker removeFromSuperview];
    self.picker = nil;
    RTKRTCVideoTrack *track = self.track;
    self.track = nil;
    WebRTCModule *webrtc = [self.bridge moduleForClass:WebRTCModule.class];
    if (track && webrtc.workerQueue) dispatch_async(webrtc.workerQueue, ^{ [track removeRenderer:self]; });
    if (message) {
        if (reject) reject(@"AbortError", message, nil);
    } else if (resolve) {
        resolve(nil);
    }
}

RCT_EXPORT_METHOD(start:(NSString *)trackId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    if (self.resolve) {
        reject(@"InvalidStateError", @"Screen recording is already starting.", nil);
        return;
    }
    self.resolve = resolve;
    self.reject = reject;
    NSUInteger generation = ++self.generation;
    WebRTCModule *webrtc = [self.bridge moduleForClass:WebRTCModule.class];
    if (!webrtc) {
        [self finishWithError:@"WebRTC is unavailable."];
        return;
    }
    dispatch_async(webrtc.workerQueue, ^{
        RTKRTCMediaStreamTrack *track = webrtc.localTracks[trackId];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (generation != self.generation || !self.resolve) return;
            if (![track isKindOfClass:RTKRTCVideoTrack.class]) {
                [self finishWithError:@"Screen recording track is unavailable."];
                return;
            }
            NSString *extension = [NSBundle.mainBundle objectForInfoDictionaryKey:@"RTCScreenSharingExtension"];
            UIWindow *window = nil;
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                if (![scene isKindOfClass:UIWindowScene.class] || scene.activationState != UISceneActivationStateForegroundActive) continue;
                for (UIWindow *candidate in ((UIWindowScene *)scene).windows) {
                    if (candidate.isKeyWindow) window = candidate;
                }
            }
            if (!window || !extension.length) {
                [self finishWithError:@"Screen recording extension is unavailable."];
                return;
            }
            self.track = (RTKRTCVideoTrack *)track;
            dispatch_async(webrtc.workerQueue, ^{ [(RTKRTCVideoTrack *)track addRenderer:self]; });
            self.picker = [[RPSystemBroadcastPickerView alloc] initWithFrame:CGRectMake(0, 0, 1, 1)];
            self.picker.preferredExtension = extension;
            self.picker.showsMicrophoneButton = NO;
            self.picker.alpha = 0.01;
            [window addSubview:self.picker];
            for (UIView *view in self.picker.subviews) {
                if ([view isKindOfClass:UIButton.class]) [(UIButton *)view sendActionsForControlEvents:UIControlEventTouchUpInside];
            }
            // The system picker has no cancellation callback. A cancelled or failed broadcast
            // must release the prepared stream, never publish an empty screen to the call.
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                if (generation == self.generation && self.resolve) [self finishWithError:@"Screen recording did not start."];
            });
        });
    });
}

- (void)setSize:(CGSize)size {}
- (void)renderFrame:(RTKRTCVideoFrame *)frame {
    if (!frame) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self.resolve) [self finishWithError:nil];
    });
}

- (void)invalidate {
    dispatch_async(dispatch_get_main_queue(), ^{ [self finishWithError:@"Screen recording was cancelled."]; });
}
@end
