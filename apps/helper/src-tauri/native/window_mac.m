#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <libproc.h>
#import <unistd.h>

typedef struct {
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
    uint32_t pid;
    uint64_t birth;
} ChalkWindowBounds;

// Require one display at the primary backing scale so Quartz and Tauri use
// the same physical coordinate space. Decline ambiguous transforms.
bool chalk_window_bounds(uint32_t id, ChalkWindowBounds *out) {
    @autoreleasepool {
        NSArray<NSDictionary *> *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
        NSUInteger index = [windows indexOfObjectPassingTest:^BOOL(NSDictionary *item, NSUInteger ignored_index __attribute__((unused)), BOOL *ignored_stop __attribute__((unused))) {
            return [item[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == id;
        }];
        if (index == NSNotFound || index > 128) return false;
        NSDictionary *target = windows[index];
        int pid = [target[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        if (pid <= 0 || pid == getpid() || [target[(__bridge NSString *)kCGWindowLayer] intValue] != 0) return false;
        CGRect rect;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)target[(__bridge NSString *)kCGWindowBounds], &rect)) return false;
        if (CGRectGetWidth(rect) < 320 || CGRectGetHeight(rect) < 240) return false;
        // Conservatively count any overlap above the target, ignoring Helper
        // windows and the cursor, which don't obscure the target.
        CGFloat limit = CGRectGetWidth(rect) * CGRectGetHeight(rect) * 0.08;
        CGFloat area = 0;
        for (NSUInteger i = 0; i < index; i++) {
            NSDictionary *candidate = windows[i];
            if ([candidate[(__bridge NSString *)kCGWindowOwnerPID] intValue] == getpid()
                || [candidate[(__bridge NSString *)kCGWindowAlpha] doubleValue] < 0.05) continue;
            CGRect frame;
            if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)candidate[(__bridge NSString *)kCGWindowBounds], &frame)) return false;
            CGRect overlap = CGRectIntersection(rect, frame);
            if (!CGRectIsNull(overlap)) area += CGRectGetWidth(overlap) * CGRectGetHeight(overlap);
            if (area > limit) return false;
        }
        // Resolve coordinates into the physical pixel space used by Tauri.
        // One scale in the virtual desktop keeps negative origins unambiguous.
        CGDirectDisplayID display[2];
        uint32_t matches = 0;
        if (CGGetDisplaysWithRect(rect, 2, display, &matches) != kCGErrorSuccess || matches != 1) return false;
        CGRect displayBounds = CGDisplayBounds(display[0]);
        CGFloat scale = CGDisplayPixelsWide(display[0]) / CGRectGetWidth(displayBounds);
        CGRect primary = CGDisplayBounds(CGMainDisplayID());
        CGFloat mainScale = CGDisplayPixelsWide(CGMainDisplayID()) / CGRectGetWidth(primary);
        if (!CGRectContainsRect(displayBounds, rect) || scale != mainScale || scale <= 0) return false;
        struct proc_bsdinfo info = {0};
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return false;
        *out = (ChalkWindowBounds){
            .x = (int32_t)llround(rect.origin.x * scale), .y = (int32_t)llround(rect.origin.y * scale),
            .width = (uint32_t)llround(rect.size.width * scale), .height = (uint32_t)llround(rect.size.height * scale),
            .pid = (uint32_t)pid, .birth = info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec,
        };
        return true;
    }
}

// Used only on explicit follow. Never request Screen Recording permission
// here; without existing consent the caller must leave the overlay off.
bool chalk_window_can_sample(void) { return CGPreflightScreenCaptureAccess(); }

bool chalk_window_sample(uint32_t id, uint8_t *output, size_t size) {
    if (!CGPreflightScreenCaptureAccess()) return false;
    @autoreleasepool {
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block NSData *data = nil;
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
            SCWindow *target = nil;
            for (SCWindow *candidate in content.windows) {
                if (candidate.windowID == id) { target = candidate; break; }
            }
            if (target == nil || error != nil) { dispatch_semaphore_signal(ready); return; }
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
            SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
            config.width = size;
            config.height = size;
            config.showsCursor = NO;
            config.ignoreShadowsSingleWindow = YES;
            config.preservesAspectRatio = NO;
            [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef image, NSError *captureError) {
                if (image && !captureError) {
                    NSMutableData *local = [NSMutableData dataWithLength:size * size * 4];
                    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
                    CGContextRef context = CGBitmapContextCreate(local.mutableBytes, size, size, 8, size * 4, color,
                        kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast);
                    if (context) {
                        CGContextSetInterpolationQuality(context, kCGInterpolationMedium);
                        CGContextDrawImage(context, CGRectMake(0, 0, size, size), image);
                        CGContextRelease(context);
                        data = local;
                    }
                    CGColorSpaceRelease(color);
                }
                dispatch_semaphore_signal(ready);
            }];
        }];
        if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 1200 * NSEC_PER_MSEC)) != 0 || !data) return false;
        memcpy(output, data.bytes, size * size * 4);
        return true;
    }
}
