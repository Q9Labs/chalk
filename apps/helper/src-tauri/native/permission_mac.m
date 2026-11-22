#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <WebKit/WebKit.h>

// Plain query of this process's Screen Recording access. It never prompts.
bool chalk_screen_access(void) {
    return CGPreflightScreenCaptureAccess();
}

static NSColor *token(CGFloat r, CGFloat g, CGFloat b, CGFloat a) {
    return [NSColor colorWithSRGBRed:r / 255.0 green:g / 255.0 blue:b / 255.0 alpha:a];
}

static NSTextField *label(NSString *text, CGFloat size, NSFontWeight weight, NSColor *color, NSRect frame) {
    NSTextField *field = [NSTextField labelWithString:text];
    field.font = [NSFont systemFontOfSize:size weight:weight];
    field.textColor = color;
    field.frame = frame;
    field.lineBreakMode = NSLineBreakByWordWrapping;
    field.maximumNumberOfLines = 2;
    return field;
}

// The Chalk Helper app tile. Dragging it carries the .app, so the user can
// drop it into the Screen Recording list instead of using the + dialog.
@interface ChalkTile : NSView <NSDraggingSource>
@property(strong) NSURL *bundle;
@property(weak) NSPanel *panel;
@property BOOL dragging;
@end

@implementation ChalkTile
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    return NSDragOperationCopy;
}

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    return YES;
}

- (void)mouseDown:(NSEvent *)event {
}

- (void)mouseDragged:(NSEvent *)event {
    if (self.dragging) return;
    self.dragging = YES;
    NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:self.bundle.path];
    icon.size = NSMakeSize(64, 64);
    NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:self.bundle];
    [item setDraggingFrame:NSMakeRect(point.x - 32, point.y - 32, 64, 64) contents:icon];
    [self beginDraggingSessionWithItems:@[ item ] event:event source:self];
}

// While a drag is in flight the panel must not sit between the tile and the list.
- (void)draggingSession:(NSDraggingSession *)session willBeginAtPoint:(NSPoint)point {
    self.panel.ignoresMouseEvents = YES;
}

- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)point operation:(NSDragOperation)operation {
    self.panel.ignoresMouseEvents = NO;
    self.dragging = NO;
}
@end

static NSPanel *tilePanel;
static NSTimer *tileTimer;
static BOOL tileSeen;
static int tileMisses;

static const CGFloat kPanelWidth = 340, kPanelHeight = 76, kGap = 8;

static NSPanel *makePanel(NSURL *bundle) {
    NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, kPanelWidth, kPanelHeight)
                                                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    panel.level = NSFloatingWindowLevel;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = YES;
    panel.hidesOnDeactivate = NO;
    panel.releasedWhenClosed = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    // Like every Helper window, keep it out of anything the sharer captures.
    panel.sharingType = NSWindowSharingNone;

    NSView *card = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, kPanelWidth, kPanelHeight)];
    card.wantsLayer = YES;
    card.layer.backgroundColor = token(6, 6, 6, 1).CGColor;
    card.layer.cornerRadius = 16;
    card.layer.borderWidth = 1;
    card.layer.borderColor = token(255, 255, 255, 0.08).CGColor;
    panel.contentView = card;

    ChalkTile *tile = [[ChalkTile alloc] initWithFrame:NSMakeRect(12, 12, 160, 52)];
    tile.bundle = bundle;
    tile.panel = panel;
    tile.wantsLayer = YES;
    tile.layer.backgroundColor = token(22, 22, 22, 1).CGColor;
    tile.layer.cornerRadius = 12;
    tile.accessibilityLabel = @"Chalk Helper app";
    tile.accessibilityHelp = @"Drag it into the Screen Recording list in System Settings.";
    NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:bundle.path];
    NSImageView *image = [NSImageView imageViewWithImage:icon];
    image.frame = NSMakeRect(10, 8, 36, 36);
    [tile addSubview:image];
    [tile addSubview:label(@"Chalk Helper", 13, NSFontWeightSemibold, token(236, 236, 238, 1), NSMakeRect(54, 17, 98, 18))];
    [card addSubview:tile];
    [card addSubview:label(@"Drag it into the list above.", 13, NSFontWeightRegular, token(154, 156, 163, 1), NSMakeRect(184, 16, 144, 44))];
    return panel;
}

// The window the user sees when System Settings is open, found by its owner's
// bundle id so a localized app name cannot hide it. Window bounds need no permission.
static BOOL settingsFrame(NSRect *out) {
    NSRunningApplication *settings = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.systempreferences"].firstObject;
    if (settings == nil) return NO;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
    for (NSDictionary *window in windows) {
        if ([window[(id)kCGWindowOwnerPID] intValue] != settings.processIdentifier || [window[(id)kCGWindowLayer] intValue] != 0) continue;
        CGRect bounds;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
        if (bounds.size.width < 300 || bounds.size.height < 300) continue;
        *out = NSMakeRect(bounds.origin.x, primaryHeight - bounds.origin.y - bounds.size.height, bounds.size.width, bounds.size.height);
        return YES;
    }
    return NO;
}

// Below the Settings window when the screen has room, over its bottom edge when not.
static NSRect panelFrameFor(NSRect window) {
    NSRect room = [NSScreen.screens.firstObject visibleFrame];
    for (NSScreen *screen in NSScreen.screens) {
        if (NSIntersectsRect(screen.frame, window)) room = screen.visibleFrame;
    }
    CGFloat x = NSMidX(window) - kPanelWidth / 2;
    CGFloat below = NSMinY(window) - kGap - kPanelHeight;
    CGFloat y = below >= NSMinY(room) ? below : NSMinY(window) + 16;
    x = MAX(NSMinX(room), MIN(x, NSMaxX(room) - kPanelWidth));
    return NSMakeRect(x, y, kPanelWidth, kPanelHeight);
}

void chalk_tile_hide(void);

static void follow(void) {
    NSRect window;
    if (settingsFrame(&window)) {
        tileSeen = YES;
        tileMisses = 0;
        NSRect frame = panelFrameFor(window);
        if (!NSEqualRects(tilePanel.frame, frame)) [tilePanel setFrame:frame display:YES];
        if (!tilePanel.visible) [tilePanel orderFrontRegardless];
        return;
    }
    // System Settings is opening, or the user closed it. Give up when it never shows or goes away.
    tileMisses++;
    if (tileMisses > (tileSeen ? 25 : 80)) chalk_tile_hide();
}

void chalk_tile_show(const char *path) {
    chalk_tile_hide();
    NSURL *bundle = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    tilePanel = makePanel(bundle);
    tileSeen = NO;
    tileMisses = 0;
    tileTimer = [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *_) {
        follow();
    }];
    follow();
}

void chalk_tile_hide(void) {
    [tileTimer invalidate];
    tileTimer = nil;
    [tilePanel orderOut:nil];
    tilePanel = nil;
}

#ifdef CHALK_PREVIEW
// Preview builds save their own windows as PNG files, because this process
// can only read its own windows without Screen Recording.
static void writePNG(NSBitmapImageRep *rep, const char *path) {
    [[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[NSString stringWithUTF8String:path] atomically:YES];
}

bool chalk_tile_snapshot(const char *path) {
    NSView *view = tilePanel.contentView;
    if (view == nil) return false;
    NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
    writePNG(rep, path);
    return true;
}

static WKWebView *findWebView(NSView *view) {
    if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
    for (NSView *child in view.subviews) {
        WKWebView *found = findWebView(child);
        if (found) return found;
    }
    return nil;
}

void chalk_webview_snapshot(void *window, const char *path) {
    NSWindow *native = (__bridge NSWindow *)window;
    WKWebView *web = findWebView(native.contentView);
    if (web == nil) return;
    NSString *file = [NSString stringWithUTF8String:path];
    [web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *_) {
        NSBitmapImageRep *rep = image ? [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation] : nil;
        if (rep) writePNG(rep, file.UTF8String);
    }];
}
#endif
