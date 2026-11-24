#import <CoreImage/CoreImage.h>
#import <XCTest/XCTest.h>
#import "ChalkAnnotationPiPContent.h"

static NSArray *PeerInk(void) {
  return @[
    @[@"stroke", @"#43dd8b", @1, @[@[@"move", @44, @150], @[@"line", @240, @150]], @8, @"round"],
    @[@"fill", @"#43dd8b", @1, @[@[@"move", @240, @138], @[@"line", @259, @150], @[@"line", @240, @162], @[@"close"]]],
    @[@"fill", @"#e39b39", @1, @[@[@"move", @277, @154], @[@"line", @277, @177], @[@"line", @294, @171], @[@"close"]]],
    @[@"fill", @"#e39b39", @1, @[@[@"rect", @290, @181, @60, @23]]],
    @[@"text", @"#0b0b0d", @1, @"Omar", @299, @192, @14],
  ];
}

static const CGSize InkFrame = {480, 300};

@interface AnnotationPiPTests : XCTestCase <AVPictureInPictureControllerDelegate>
@property(nonatomic) XCTestExpectation *pictureInPictureStarted;
@end

@implementation AnnotationPiPTests

- (void)assertPixel:(CVPixelBufferRef)pixelBuffer x:(size_t)x y:(size_t)y
                red:(uint8_t)red green:(uint8_t)green blue:(uint8_t)blue {
  CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
  const uint8_t *base = CVPixelBufferGetBaseAddress(pixelBuffer);
  const uint8_t *pixel = base + y * CVPixelBufferGetBytesPerRow(pixelBuffer) + 4 * x;
  XCTAssertEqualWithAccuracy(pixel[2], red, 1);
  XCTAssertEqualWithAccuracy(pixel[1], green, 1);
  XCTAssertEqualWithAccuracy(pixel[0], blue, 1);
  CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
}

- (void)attachFrame:(CVPixelBufferRef)pixels name:(NSString *)name {
  CIImage *bufferImage = [CIImage imageWithCVPixelBuffer:pixels];
  CGImageRef image = [[CIContext context] createCGImage:bufferImage fromRect:bufferImage.extent];
  XCTAssertNotEqual(image, NULL);
  if (!image) return;
  XCTAttachment *attachment = [XCTAttachment attachmentWithImage:[UIImage imageWithCGImage:image]];
  attachment.name = name;
  attachment.lifetime = XCTAttachmentLifetimeKeepAlways;
  [self addAttachment:attachment];
  CGImageRelease(image);
}

- (void)testSharerContentShowsPeerInkAndStopsWithShare {
  // This is the same protected content controller the native module hands to
  // AVKit. Test its actual output on Simulator even when AVKit cannot float it.
  NSLog(@"AVKit system PiP supported: %@", AVPictureInPictureController.isPictureInPictureSupported ? @"YES" : @"NO");
  Class contentClass = NSClassFromString(@"ChalkAnnotationPiPContent");
  XCTAssertNotNil(contentClass);
  ChalkAnnotationPiPContent *content = [[contentClass alloc] initWithFrameSize:InkFrame];
  AVSampleBufferDisplayLayer *surface = (AVSampleBufferDisplayLayer *)content.view.subviews.firstObject.layer;
  XCTAssertTrue([surface isKindOfClass:AVSampleBufferDisplayLayer.class]);
  XCTAssertTrue(surface.preventsCapture);

  CMSampleBufferRef before = [content copyNextSampleBuffer];
  XCTAssertNotEqual(before, NULL);
  if (!before) return;
  CVPixelBufferRef blank = CMSampleBufferGetImageBuffer(before);
  XCTAssertEqual(CVPixelBufferGetWidth(blank), 480);
  XCTAssertEqual(CVPixelBufferGetHeight(blank), 300);
  [self assertPixel:blank x:100 y:150 red:26 green:28 blue:33];
  [self attachFrame:blank name:@"sharer-before-peer-mark"];
  CFRelease(before);

  // Inject the peer paint operations at the native bridge boundary.
  NSArray *ink = PeerInk();
  [content setInk:ink frameSize:InkFrame];
  CMSampleBufferRef after = [content copyNextSampleBuffer];
  XCTAssertNotEqual(after, NULL);
  if (!after) return;
  CVPixelBufferRef painted = CMSampleBufferGetImageBuffer(after);
  [self assertPixel:painted x:100 y:150 red:67 green:221 blue:139];
  [self assertPixel:painted x:283 y:169 red:227 green:155 blue:57];
  [self assertPixel:painted x:345 y:197 red:227 green:155 blue:57];
  [self attachFrame:painted name:@"sharer-peer-cursor-and-mark"];
  CFRelease(after);

  [content stop];
  [content setInk:ink frameSize:InkFrame]; // Ignore a late update after the share has stopped.
  CMSampleBufferRef stopped = [content copyNextSampleBuffer];
  XCTAssertEqual(stopped, NULL);
  if (stopped) CFRelease(stopped);
  XCTAssertNil(surface.superlayer);
}

- (void)testRotatingVideoKeepsThePreviewAndProjectsInkIntoTheNewFrame {
  Class contentClass = NSClassFromString(@"ChalkAnnotationPiPContent");
  ChalkAnnotationPiPContent *content = [[contentClass alloc] initWithFrameSize:InkFrame];
  [content setInk:PeerInk() frameSize:InkFrame];

  CIImage *blue = [CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:1]];
  CIImage *landscape = [blue imageByCroppingToRect:CGRectMake(0, 0, 1600, 1000)];
  [content setVideoFrame:landscape];
  CMSampleBufferRef before = [content copyNextSampleBuffer];
  XCTAssertNotEqual(before, NULL);
  if (!before) return;
  CVPixelBufferRef wide = CMSampleBufferGetImageBuffer(before);
  XCTAssertEqual(CVPixelBufferGetWidth(wide), 480);
  XCTAssertEqual(CVPixelBufferGetHeight(wide), 300);
  [self assertPixel:wide x:10 y:10 red:0 green:0 blue:255];
  CFRelease(before);

  [content setVideoFrame:[landscape imageByApplyingOrientation:kCGImagePropertyOrientationRight]];
  CMSampleBufferRef rotated = [content copyNextSampleBuffer];
  XCTAssertNotEqual(rotated, NULL);
  if (!rotated) return;
  CVPixelBufferRef tall = CMSampleBufferGetImageBuffer(rotated);
  XCTAssertEqual(CVPixelBufferGetWidth(tall), 300);
  XCTAssertEqual(CVPixelBufferGetHeight(tall), 480);
  XCTAssertEqual(content.preferredContentSize.width, 300);
  XCTAssertEqual(content.preferredContentSize.height, 480);
  [self assertPixel:tall x:10 y:10 red:0 green:0 blue:255];
  [self assertPixel:tall x:62 y:240 red:67 green:221 blue:139];
  [self attachFrame:tall name:@"sharer-rotated-preview-with-peer-ink"];
  CFRelease(rotated);
}

- (void)testSystemPiPDisplaysNewInkAfterBackgroundingWhenAvailable {
  if (!AVPictureInPictureController.isPictureInPictureSupported) {
    XCTSkip(@"This Simulator does not support system picture-in-picture.");
    return;
  }

  UIApplication *app = UIApplication.sharedApplication;
  UIWindow *window = app.delegate.window;
  UIView *source = window.rootViewController.view;
  XCTAssertNotNil(source.window);
  if (!source.window) return;

  Class contentClass = NSClassFromString(@"ChalkAnnotationPiPContent");
  ChalkAnnotationPiPContent *content = [[contentClass alloc] initWithFrameSize:InkFrame];
  AVPictureInPictureControllerContentSource *call = [[AVPictureInPictureControllerContentSource alloc]
      initWithActiveVideoCallSourceView:source contentViewController:content];
  AVPictureInPictureController *controller = [[AVPictureInPictureController alloc] initWithContentSource:call];
  controller.delegate = self;
  [content displayNextFrame];

  NSPredicate *isPossible = [NSPredicate predicateWithFormat:@"pictureInPicturePossible == YES"];
  XCTestExpectation *ready = [[XCTNSPredicateExpectation alloc] initWithPredicate:isPossible object:controller];
  if ([XCTWaiter waitForExpectations:@[ready] timeout:3] != XCTWaiterResultCompleted) {
    XCTSkip(@"AVKit reports PiP support, but never makes this Simulator video-call source possible.");
    return;
  }

  self.pictureInPictureStarted = [[XCTestExpectation alloc] initWithDescription:@"AVKit activated picture-in-picture"];
  [controller startPictureInPicture];
  [self waitForExpectations:@[self.pictureInPictureStarted] timeout:6];
  XCTAssertTrue(controller.isPictureInPictureActive);
  if (!controller.isPictureInPictureActive) return;

  XCTNSNotificationExpectation *backgrounded = [[XCTNSNotificationExpectation alloc]
      initWithName:UIApplicationDidEnterBackgroundNotification object:app];
  // Open the app's system settings via UIKit so the test does not need a UI runner.
  [app openURL:[NSURL URLWithString:UIApplicationOpenSettingsURLString] options:@{} completionHandler:nil];
  [self waitForExpectations:@[backgrounded] timeout:15];
  XCTAssertEqual(app.applicationState, UIApplicationStateBackground);
  XCTAssertTrue(controller.isPictureInPictureActive);

  NSArray *ink = PeerInk();
  [content setInk:ink frameSize:InkFrame];
  CMSampleBufferRef updated = [content copyNextSampleBuffer];
  XCTAssertNotEqual(updated, NULL);
  if (updated) {
    CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(updated);
    [self assertPixel:pixels x:100 y:150 red:67 green:221 blue:139];
    [self assertPixel:pixels x:283 y:169 red:227 green:155 blue:57];
    [self attachFrame:pixels name:@"sharer-backgrounded-peer-ink"];
    CFRelease(updated);
  }
  [content setInk:ink frameSize:InkFrame];
  [content displayNextFrame];

  CIImage *portrait = [[CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:1]] imageByCroppingToRect:CGRectMake(0, 0, 1000, 1600)];
  [content setVideoFrame:portrait];
  [content displayNextFrame];
  XCTAssertEqual(content.preferredContentSize.height, 480);
  XCTAssertTrue(controller.isPictureInPictureActive);

  [controller stopPictureInPicture];
  controller.delegate = nil;
  controller.contentSource = nil;
  [content stop];
  NSPredicate *isStopped = [NSPredicate predicateWithFormat:@"pictureInPictureActive == NO"];
  XCTestExpectation *stopped = [[XCTNSPredicateExpectation alloc] initWithPredicate:isStopped object:controller];
  [self waitForExpectations:@[stopped] timeout:6];
  CMSampleBufferRef lateFrame = [content copyNextSampleBuffer];
  XCTAssertEqual(lateFrame, NULL);
  if (lateFrame) CFRelease(lateFrame);
}

- (void)pictureInPictureControllerDidStartPictureInPicture:(AVPictureInPictureController *)controller {
  [self.pictureInPictureStarted fulfill];
}

- (void)pictureInPictureController:(AVPictureInPictureController *)controller
    failedToStartPictureInPictureWithError:(NSError *)error {
  XCTFail(@"AVKit reported the video-call source was possible, but could not start: %@", error);
  [self.pictureInPictureStarted fulfill];
}

@end
