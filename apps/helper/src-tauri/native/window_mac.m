#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ColorSync/ColorSyncDevice.h>
#import <libproc.h>
#import <unistd.h>
#import <stdatomic.h>

typedef struct {
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
    uint32_t pid;
    uint64_t birth;
} ChalkWindowBounds;

static _Atomic(uint32_t) live_overlay;

bool chalk_window_ignore_overlay(void *applicationWindow) {
    NSWindow *window = (__bridge NSWindow *)applicationWindow;
    NSInteger number = window.windowNumber;
    if (number <= 0 || number > UINT32_MAX) return false;
    atomic_store(&live_overlay, (uint32_t)number);
    return true;
}

static bool covers(CGRect target, CGRect above) {
    return !CGRectIsEmpty(CGRectIntersection(target, above));
}

bool chalk_window_test_cover(uint32_t width, uint32_t height) {
    return covers(CGRectMake(0, 0, 800, 600), CGRectMake(799, 1, width, height));
}

// Tauri uses physical coordinates. A mirrored or ambiguous match is not safe.
bool chalk_display_identity(int32_t x, int32_t y, uint32_t width, uint32_t height, uint8_t *out) {
    CGDirectDisplayID displays[32], selected = kCGNullDirectDisplay;
    uint32_t count = 0;
    if (CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess || count >= 32) return false;
    for (uint32_t i = 0; i < count; i++) {
        CGDirectDisplayID display = displays[i];
        CGRect bounds = CGDisplayBounds(display);
        if (CGRectIsEmpty(bounds)) continue;
        CGFloat scale = CGDisplayPixelsWide(display) / CGRectGetWidth(bounds);
        if (llround(bounds.origin.x * scale) != x || llround(bounds.origin.y * scale) != y ||
            llround(bounds.size.width * scale) != width || llround(bounds.size.height * scale) != height) continue;
        if (selected != kCGNullDirectDisplay || CGDisplayIsInMirrorSet(display)) return false;
        selected = display;
    }
    if (selected == kCGNullDirectDisplay) return false;
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(selected);
    if (uuid == NULL) return false;
    CFStringRef string = CFUUIDCreateString(NULL, uuid);
    CFRelease(uuid);
    if (string == NULL) return false;
    bool ok = CFStringGetCString(string, (char *)out, 37, kCFStringEncodingASCII);
    CFRelease(string);
    return ok;
}

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
        // Conservatively count any overlap above the target, ignoring the Helper
        // overlay and transparent windows, which do not obscure the target.
        for (NSUInteger i = 0; i < index; i++) {
            NSDictionary *candidate = windows[i];
            uint32_t number = [candidate[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
            if (number != 0 && number == atomic_load(&live_overlay)) continue;
            NSNumber *alpha = candidate[(__bridge NSString *)kCGWindowAlpha];
            if (alpha != nil && alpha.doubleValue <= 0) continue;
            CGRect frame;
            if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)candidate[(__bridge NSString *)kCGWindowBounds], &frame)) return false;
            if (covers(rect, frame)) return false;
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

// Sampling only preflights. It never prompts; Helper's onboarding owns the ask.
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
            // Capture at the window's aspect ratio. ScreenCaptureKit may pad
            // a square output before our own landmark resampling.
            CGRect frame = target.frame;
            CGFloat longest = MAX(frame.size.width, frame.size.height);
            if (longest <= 0) { dispatch_semaphore_signal(ready); return; }
            CGFloat sampleScale = (4.0 * size) / longest;
            SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
            config.width = MAX(1, llround(frame.size.width * sampleScale));
            config.height = MAX(1, llround(frame.size.height * sampleScale));
            config.showsCursor = NO;
            config.ignoreShadowsSingleWindow = YES;
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
