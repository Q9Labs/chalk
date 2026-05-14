#import "ChalkMeetingMultitasking.h"

#import <AVKit/AVKit.h>
#import <React/RCTBridge.h>
#import <React/RCTUtils.h>
#import <RTKWebRTC/RTCMTLVideoView.h>
#import <RTKWebRTC/RTCMediaStream.h>
#import <RTKWebRTC/RTCVideoTrack.h>

#import "WebRTCModule.h"

static NSString *const ChalkPiPPlaceholderText = @"Meeting continues in Picture in Picture";

@interface ChalkMeetingPictureInPictureContentViewController : AVPictureInPictureVideoCallViewController
@property(nonatomic, strong) UILabel *roomLabel;
@property(nonatomic, strong) UILabel *participantLabel;
@property(nonatomic, strong) UILabel *statusLabel;
@property(nonatomic, strong) RTKRTCMTLVideoView *videoView;
@property(nonatomic, strong) UIView *placeholderView;
@end

@implementation ChalkMeetingPictureInPictureContentViewController

- (instancetype)init {
    self = [super init];
    if (self) {
        self.view.backgroundColor = [UIColor blackColor];

        _videoView = [[RTKRTCMTLVideoView alloc] initWithFrame:CGRectZero];
        _videoView.translatesAutoresizingMaskIntoConstraints = NO;

        _placeholderView = [[UIView alloc] initWithFrame:CGRectZero];
        _placeholderView.translatesAutoresizingMaskIntoConstraints = NO;
        _placeholderView.backgroundColor = [UIColor colorWithRed:0.03 green:0.04 blue:0.08 alpha:1.0];

        UILabel *placeholderLabel = [[UILabel alloc] initWithFrame:CGRectZero];
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = NO;
        placeholderLabel.text = ChalkPiPPlaceholderText;
        placeholderLabel.textColor = [UIColor colorWithWhite:1.0 alpha:0.9];
        placeholderLabel.font = [UIFont systemFontOfSize:17 weight:UIFontWeightSemibold];
        placeholderLabel.textAlignment = NSTextAlignmentCenter;
        placeholderLabel.numberOfLines = 2;
        [_placeholderView addSubview:placeholderLabel];

        _roomLabel = [[UILabel alloc] initWithFrame:CGRectZero];
        _roomLabel.translatesAutoresizingMaskIntoConstraints = NO;
        _roomLabel.textColor = [UIColor colorWithWhite:1.0 alpha:0.95];
        _roomLabel.font = [UIFont systemFontOfSize:18 weight:UIFontWeightSemibold];
        _roomLabel.numberOfLines = 2;

        _participantLabel = [[UILabel alloc] initWithFrame:CGRectZero];
        _participantLabel.translatesAutoresizingMaskIntoConstraints = NO;
        _participantLabel.textColor = [UIColor colorWithWhite:1.0 alpha:0.9];
        _participantLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightMedium];

        _statusLabel = [[UILabel alloc] initWithFrame:CGRectZero];
        _statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
        _statusLabel.textColor = [UIColor colorWithWhite:1.0 alpha:0.7];
        _statusLabel.font = [UIFont systemFontOfSize:12 weight:UIFontWeightRegular];

        UIView *labelStack = [[UIView alloc] initWithFrame:CGRectZero];
        labelStack.translatesAutoresizingMaskIntoConstraints = NO;
        labelStack.backgroundColor = [UIColor colorWithWhite:0.0 alpha:0.36];
        labelStack.layer.cornerRadius = 16;

        [labelStack addSubview:_roomLabel];
        [labelStack addSubview:_participantLabel];
        [labelStack addSubview:_statusLabel];

        [self.view addSubview:_videoView];
        [self.view addSubview:_placeholderView];
        [self.view addSubview:labelStack];

        [NSLayoutConstraint activateConstraints:@[
            [_videoView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
            [_videoView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
            [_videoView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
            [_videoView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],

            [_placeholderView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
            [_placeholderView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
            [_placeholderView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
            [_placeholderView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],

            [placeholderLabel.centerXAnchor constraintEqualToAnchor:_placeholderView.centerXAnchor],
            [placeholderLabel.centerYAnchor constraintEqualToAnchor:_placeholderView.centerYAnchor],
            [placeholderLabel.leadingAnchor constraintGreaterThanOrEqualToAnchor:_placeholderView.leadingAnchor constant:20],
            [placeholderLabel.trailingAnchor constraintLessThanOrEqualToAnchor:_placeholderView.trailingAnchor constant:-20],

            [labelStack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:16],
            [labelStack.trailingAnchor constraintLessThanOrEqualToAnchor:self.view.trailingAnchor constant:-16],
            [labelStack.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor constant:-16],

            [_roomLabel.topAnchor constraintEqualToAnchor:labelStack.topAnchor constant:10],
            [_roomLabel.leadingAnchor constraintEqualToAnchor:labelStack.leadingAnchor constant:12],
            [_roomLabel.trailingAnchor constraintEqualToAnchor:labelStack.trailingAnchor constant:-12],

            [_participantLabel.topAnchor constraintEqualToAnchor:_roomLabel.bottomAnchor constant:4],
            [_participantLabel.leadingAnchor constraintEqualToAnchor:labelStack.leadingAnchor constant:12],
            [_participantLabel.trailingAnchor constraintEqualToAnchor:labelStack.trailingAnchor constant:-12],

            [_statusLabel.topAnchor constraintEqualToAnchor:_participantLabel.bottomAnchor constant:4],
            [_statusLabel.leadingAnchor constraintEqualToAnchor:labelStack.leadingAnchor constant:12],
            [_statusLabel.trailingAnchor constraintEqualToAnchor:labelStack.trailingAnchor constant:-12],
            [_statusLabel.bottomAnchor constraintEqualToAnchor:labelStack.bottomAnchor constant:-10],
        ]];
    }
    return self;
}

@end

@interface ChalkMeetingMultitasking () <AVPictureInPictureControllerDelegate>
@property(nonatomic, weak) RCTBridge *bridge;
@property(nonatomic, strong) AVPictureInPictureController *pictureInPictureController;
@property(nonatomic, strong) ChalkMeetingPictureInPictureContentViewController *contentViewController;
@property(nonatomic, strong) RTKRTCVideoTrack *currentVideoTrack;
@property(nonatomic, copy) NSString *roomName;
@property(nonatomic, copy) NSString *participantName;
@property(nonatomic, copy) NSString *streamURL;
@property(nonatomic, assign) BOOL cameraOff;
@property(nonatomic, assign) BOOL muted;
@end

@implementation ChalkMeetingMultitasking

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
    return YES;
}

- (dispatch_queue_t)methodQueue {
    return dispatch_get_main_queue();
}

- (UIView *)activeSourceView {
    UIWindow *window = RCTKeyWindow();
    if (window != nil) {
        return window.rootViewController.view ?: window;
    }

    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) {
            continue;
        }

        UIWindowScene *windowScene = (UIWindowScene *)scene;
        for (UIWindow *candidate in windowScene.windows) {
          if (candidate.isKeyWindow) {
              return candidate.rootViewController.view ?: candidate;
          }
        }
    }

    id<UIApplicationDelegate> appDelegate = UIApplication.sharedApplication.delegate;
    if ([appDelegate respondsToSelector:@selector(window)]) {
        UIWindow *delegateWindow = [appDelegate performSelector:@selector(window)];
        return delegateWindow.rootViewController.view ?: delegateWindow;
    }

    return nil;
}

- (ChalkMeetingPictureInPictureContentViewController *)ensureContentViewController {
    if (_contentViewController == nil) {
        _contentViewController = [[ChalkMeetingPictureInPictureContentViewController alloc] init];
    }

    return _contentViewController;
}

- (AVPictureInPictureController *)ensurePictureInPictureController {
    if (@available(iOS 15.0, *)) {
        if (_pictureInPictureController == nil) {
            UIView *sourceView = [self activeSourceView];
            if (sourceView == nil) {
                return nil;
            }

            AVPictureInPictureControllerContentSource *contentSource =
                [[AVPictureInPictureControllerContentSource alloc] initWithActiveVideoCallSourceView:sourceView
                                                                                contentViewController:[self ensureContentViewController]];
            _pictureInPictureController = [[AVPictureInPictureController alloc] initWithContentSource:contentSource];
            _pictureInPictureController.delegate = self;
        }

        return _pictureInPictureController;
    }

    return nil;
}

- (WebRTCModule *)webRTCModule {
    return [self.bridge moduleForName:@"WebRTCModule"];
}

- (void)detachCurrentTrackRenderer {
    if (_currentVideoTrack == nil || _contentViewController == nil) {
        return;
    }

    WebRTCModule *webRTCModule = [self webRTCModule];
    dispatch_queue_t workerQueue = webRTCModule.workerQueue ?: dispatch_get_main_queue();
    RTKRTCVideoTrack *videoTrack = _currentVideoTrack;
    RTKRTCMTLVideoView *videoView = _contentViewController.videoView;
    dispatch_async(workerQueue, ^{
        [videoTrack removeRenderer:videoView];
    });
    _currentVideoTrack = nil;
}

- (void)attachTrackForStreamURL:(NSString *)streamURL {
    [self detachCurrentTrackRenderer];

    if (streamURL == nil || streamURL.length == 0) {
        self.contentViewController.videoView.hidden = YES;
        self.contentViewController.placeholderView.hidden = NO;
        return;
    }

    WebRTCModule *webRTCModule = [self webRTCModule];
    RTKRTCMediaStream *stream = [webRTCModule streamForReactTag:streamURL];
    RTKRTCVideoTrack *videoTrack = (RTKRTCVideoTrack *)stream.videoTracks.firstObject;

    if (videoTrack == nil) {
        self.contentViewController.videoView.hidden = YES;
        self.contentViewController.placeholderView.hidden = NO;
        return;
    }

    self.contentViewController.videoView.hidden = NO;
    self.contentViewController.placeholderView.hidden = YES;
    self.currentVideoTrack = videoTrack;

    dispatch_queue_t workerQueue = webRTCModule.workerQueue ?: dispatch_get_main_queue();
    RTKRTCMTLVideoView *videoView = self.contentViewController.videoView;
    dispatch_async(workerQueue, ^{
        [videoTrack addRenderer:videoView];
    });
}

- (void)refreshContent {
    ChalkMeetingPictureInPictureContentViewController *contentViewController = [self ensureContentViewController];
    contentViewController.roomLabel.text = self.roomName.length > 0 ? self.roomName : @"Chalk meeting";
    contentViewController.participantLabel.text = self.participantName.length > 0 ? self.participantName : @"Meeting";
    contentViewController.statusLabel.text = self.cameraOff ? @"Audio only" : (self.muted ? @"Mic muted" : @"Live");
    [self attachTrackForStreamURL:self.streamURL];
}

RCT_REMAP_METHOD(isPictureInPictureSupported,
                 isPictureInPictureSupportedWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    if (@available(iOS 15.0, *)) {
        resolve(@([AVPictureInPictureController isPictureInPictureSupported]));
        return;
    }

    resolve(@(NO));
}

RCT_REMAP_METHOD(isPictureInPictureActive,
                 isPictureInPictureActiveWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    resolve(@(self.pictureInPictureController.isPictureInPictureActive));
}

RCT_REMAP_METHOD(setPictureInPictureEnabled,
                 setPictureInPictureEnabled:(BOOL)enabled
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    if (enabled) {
        [self ensurePictureInPictureController];
        [self refreshContent];
    } else {
        [self.pictureInPictureController stopPictureInPicture];
        [self detachCurrentTrackRenderer];
    }

    resolve(nil);
}

RCT_REMAP_METHOD(updatePictureInPictureConfig,
                 updatePictureInPictureConfig:(NSDictionary *)config
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    self.roomName = [config[@"roomName"] isKindOfClass:[NSString class]] ? config[@"roomName"] : @"Chalk meeting";
    self.participantName = [config[@"participantName"] isKindOfClass:[NSString class]] ? config[@"participantName"] : @"Meeting";
    self.streamURL = [config[@"streamURL"] isKindOfClass:[NSString class]] ? config[@"streamURL"] : nil;
    self.cameraOff = [config[@"cameraOff"] boolValue];
    self.muted = [config[@"muted"] boolValue];

    [self ensurePictureInPictureController];
    [self refreshContent];
    resolve(nil);
}

RCT_REMAP_METHOD(startPictureInPicture,
                 startPictureInPictureWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    if (@available(iOS 15.0, *)) {
        AVPictureInPictureController *controller = [self ensurePictureInPictureController];
        if (controller != nil && controller.isPictureInPicturePossible && !controller.isPictureInPictureActive) {
            [self refreshContent];
            [controller startPictureInPicture];
        }
    }

    resolve(nil);
}

RCT_REMAP_METHOD(stopPictureInPicture,
                 stopPictureInPictureWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    [self.pictureInPictureController stopPictureInPicture];
    resolve(nil);
}

RCT_REMAP_METHOD(startBackgroundMode,
                 startBackgroundMode:(NSDictionary *)config
                 backgroundResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    resolve(nil);
}

RCT_REMAP_METHOD(stopBackgroundMode,
                 stopBackgroundModeWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
    resolve(nil);
}

- (void)pictureInPictureControllerDidStopPictureInPicture:(AVPictureInPictureController *)pictureInPictureController API_AVAILABLE(ios(15.0)) {
    [self detachCurrentTrackRenderer];
}

- (void)invalidate {
    [self detachCurrentTrackRenderer];
    [self.pictureInPictureController stopPictureInPicture];
    self.pictureInPictureController = nil;
    self.contentViewController = nil;
}

@end
