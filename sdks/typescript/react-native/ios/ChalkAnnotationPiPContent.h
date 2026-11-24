#import <AVKit/AVKit.h>

NS_ASSUME_NONNULL_BEGIN

/// The AVKit content source and its local-only annotation frames.
@interface ChalkAnnotationPiPContent : AVPictureInPictureVideoCallViewController
- (instancetype)initWithFrameSize:(CGSize)size;
- (void)setInk:(NSArray<NSArray *> *)ink;
- (void)setBackgroundImage:(nullable UIImage *)image;
- (nullable CMSampleBufferRef)copyNextSampleBuffer CF_RETURNS_RETAINED;
- (BOOL)isReadyToDisplay;
- (void)displayNextFrame;
- (void)stop;
@end

NS_ASSUME_NONNULL_END
