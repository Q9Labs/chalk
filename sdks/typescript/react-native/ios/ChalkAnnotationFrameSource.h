#import <CoreImage/CoreImage.h>
#import <React/RCTBridge.h>
#import <RTKWebRTC/RTKWebRTC.h>

@interface ChalkAnnotationObservation : NSObject <RTKRTCVideoRenderer>
@property(nonatomic, strong) RTKRTCVideoTrack *track;
@property(nonatomic, strong) RTKRTCVideoFrame *frame;
@property(nonatomic, copy) void (^onSize)(CGSize);
@end

// Attach on the WebRTC worker queue; completion runs on the main queue.
void ChalkFindAnnotationTrack(RCTBridge *bridge, NSString *streamUrl, void (^completion)(RTKRTCVideoTrack *track));
void ChalkFindLocalAnnotationTrack(RCTBridge *bridge, NSString *trackId, void (^completion)(RTKRTCVideoTrack *track));
CIImage *ChalkAnnotationFrameImage(RTKRTCVideoFrame *frame);
CGSize ChalkAnnotationFrameSize(RTKRTCVideoFrame *frame);
