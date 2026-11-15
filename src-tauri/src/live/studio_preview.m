#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <stdbool.h>
#include <stdatomic.h>

struct obs_display;
extern void obs_display_set_enabled(struct obs_display *display, bool enabled);
extern void obs_display_resize(struct obs_display *display, uint32_t width, uint32_t height);
extern int producer_studio_preview_screen_rect(void *window, const double normalized[4],
                                              double screen[4]);

@interface ProducerStudioPreviewView : NSView <NSWindowDelegate> {
@public
    atomic_bool closed;
    atomic_bool floating;
}
@property (nonatomic, strong) NSPanel *previewPanel;
@property (nonatomic, weak) NSSegmentedControl *framingControl;
@end

@implementation ProducerStudioPreviewView
- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        atomic_init(&closed, false);
        atomic_init(&floating, false);
    }
    return self;
}

- (void)windowWillClose:(NSNotification *)notification {
    (void)notification;
    atomic_store_explicit(&closed, true, memory_order_release);
}

- (void)changeFraming:(NSSegmentedControl *)sender {
    atomic_store_explicit(&floating, sender.selectedSegment == 1, memory_order_release);
}
@end

@interface ProducerStudioStageView : ProducerStudioPreviewView
@property (nonatomic, weak) NSWindow *hostWindow;
@property (nonatomic) struct obs_display *display;
@property (nonatomic) BOOL requested;
@property (nonatomic) BOOL positioned;
@property (nonatomic) NSSize displaySize;
- (void)observeHost;
- (void)refreshDisplaySize;
- (void)refreshVisibility;
@end

@implementation ProducerStudioStageView
- (void)observeHost {
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    NSWindow *host = self.hostWindow;
    for (NSNotificationName name in @[
        NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification,
        NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification,
        NSWindowDidChangeOcclusionStateNotification
    ]) {
        [center addObserver:self selector:@selector(hostVisibilityChanged:) name:name object:host];
    }
    [center addObserver:self selector:@selector(hostResized:) name:NSWindowDidResizeNotification object:host];
    [center addObserver:self selector:@selector(hostWillClose:) name:NSWindowWillCloseNotification object:host];
    [center addObserver:self selector:@selector(hostVisibilityChanged:) name:NSApplicationDidBecomeActiveNotification object:NSApp];
    [center addObserver:self selector:@selector(hostVisibilityChanged:) name:NSApplicationDidResignActiveNotification object:NSApp];
    [center addObserver:self selector:@selector(backingChanged:) name:NSWindowDidChangeBackingPropertiesNotification object:self.previewPanel];
}

- (void)hostVisibilityChanged:(NSNotification *)event {
    (void)event;
    [self refreshVisibility];
}

- (void)hostResized:(NSNotification *)event {
    (void)event;
    // The webview sends the new canvas rectangle after its layout finishes.
    self.positioned = NO;
    [self refreshVisibility];
}

- (void)hostWillClose:(NSNotification *)event {
    (void)event;
    atomic_store_explicit(&closed, true, memory_order_release);
    self.requested = NO;
    [self refreshVisibility];
}

- (void)backingChanged:(NSNotification *)event {
    (void)event;
    [self refreshDisplaySize];
}

- (void)refreshDisplaySize {
    if (!self.display) return;
    NSSize backing = [self convertRectToBacking:self.bounds].size;
    NSSize size = NSMakeSize(MAX(1, round(backing.width)), MAX(1, round(backing.height)));
    if (NSEqualSizes(size, self.displaySize)) return;
    self.displaySize = size;
    obs_display_resize(self.display, (uint32_t)size.width, (uint32_t)size.height);
}

- (void)refreshVisibility {
    NSWindow *host = self.hostWindow;
    NSPanel *panel = self.previewPanel;
    BOOL visible = self.requested && self.positioned && self.display &&
                   NSApp.isActive && host.isVisible && host.isKeyWindow &&
                   host.isOnActiveSpace && !host.isMiniaturized;
    obs_display_set_enabled(self.display, visible);
    if (visible) {
        if (panel.parentWindow != host) [host addChildWindow:panel ordered:NSWindowAbove];
        if (!panel.isVisible) [panel orderFront:nil];
    } else if (panel.isVisible) {
        [panel orderOut:nil];
    }
}
@end

static void preview_main(void (^block)(void)) {
    if (NSThread.isMainThread) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

void *producer_studio_preview_create(void *main_window, double *width, double *height) {
    if (!main_window || !width || !height) return NULL;

    __block void *drawable = NULL;
    preview_main(^{
        NSWindow *main = (__bridge NSWindow *)main_window;
        NSScreen *screen = main.screen ?: NSScreen.mainScreen;
        if (!screen) return;

        // This is a separate top-level window. ScreenCaptureKit only captures
        // Producer's main window, so the monitor stays out of its own feed.
        NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                  NSWindowStyleMaskUtilityWindow | NSWindowStyleMaskNonactivatingPanel;
        NSRect visible = screen.visibleFrame;
        const CGFloat margin = 16;
        const CGFloat controlsHeight = 38;
        NSRect testFrame = [NSPanel frameRectForContentRect:NSMakeRect(0, 0, 640, 360 + controlsHeight)
                                                 styleMask:style];
        CGFloat chromeHeight = NSHeight(testFrame) - (360 + controlsHeight);
        CGFloat videoWidth = floor(MIN(640, MIN(NSWidth(visible) - 2 * margin,
            (NSHeight(visible) - 2 * margin - chromeHeight - controlsHeight) * 16 / 9)));
        if (videoWidth < 192) return;
        CGFloat videoHeight = videoWidth * 9 / 16;
        NSRect contentRect = NSMakeRect(0, 0, videoWidth, videoHeight + controlsHeight);

        NSPanel *panel = [[NSPanel alloc] initWithContentRect:contentRect
                                                   styleMask:style
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO
                                                      screen:screen];
        if (!panel) return;
        panel.title = @"Studio Program Preview";
        panel.releasedWhenClosed = NO;
        panel.floatingPanel = YES;
        panel.becomesKeyOnlyIfNeeded = YES;
        // Keep it available while the operator works across windows. The
        // engine never has to render a display for an automatically hidden panel.
        panel.hidesOnDeactivate = NO;
        panel.excludedFromWindowsMenu = YES;
        panel.tabbingMode = NSWindowTabbingModeDisallowed;
        panel.animationBehavior = NSWindowAnimationBehaviorNone;

        NSView *content = [[NSView alloc] initWithFrame:contentRect];
        content.wantsLayer = YES;
        content.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
        panel.contentView = content;

        ProducerStudioPreviewView *view = [[ProducerStudioPreviewView alloc]
            initWithFrame:NSMakeRect(0, controlsHeight, videoWidth, videoHeight)];
        view.wantsLayer = YES;
        view.layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
        view.layer.masksToBounds = YES;
        [content addSubview:view];
        view.previewPanel = panel;
        panel.delegate = view;

        NSSegmentedControl *framing = [NSSegmentedControl segmentedControlWithLabels:@[@"Flat", @"Floating"]
                                                                       trackingMode:NSSegmentSwitchTrackingSelectOne
                                                                             target:view
                                                                             action:@selector(changeFraming:)];
        framing.segmentStyle = NSSegmentStyleRounded;
        framing.selectedSegment = 0;
        framing.toolTip = @"Studio output framing";
        [framing setAccessibilityLabel:@"Studio output framing"];
        [framing sizeToFit];
        [framing setFrameOrigin:NSMakePoint(floor((videoWidth - NSWidth(framing.frame)) / 2),
                                          floor((controlsHeight - NSHeight(framing.frame)) / 2))];
        [content addSubview:framing];
        view.framingControl = framing;

        NSRect frame = panel.frame;
        CGFloat left = NSMinX(visible) + margin;
        CGFloat right = NSMaxX(visible) - margin - NSWidth(frame);
        CGFloat top = NSMaxY(visible) - margin;
        CGFloat bottom = NSMinY(visible) + margin + NSHeight(frame);
        // Prefer a clear left margin, then overlap the left of the room.
        CGFloat beside = NSMinX(main.frame) - NSWidth(frame) - margin;
        CGFloat x = beside >= left ? beside : NSMinX(main.frame) + margin;
        CGFloat y = NSMaxY(main.frame) - 56;
        [panel setFrameTopLeftPoint:NSMakePoint(MAX(left, MIN(right, x)), MAX(bottom, MIN(top, y)))];

        NSRect pixels = [view convertRectToBacking:view.bounds];
        *width = round(NSWidth(pixels));
        *height = round(NSHeight(pixels));
        drawable = (void *)CFBridgingRetain(view);
    });
    return drawable;
}

static NSRect stage_frame(NSWindow *host, const double normalized[4]) {
    double frame[4];
    if (!producer_studio_preview_screen_rect((__bridge void *)host, normalized, frame))
        return NSZeroRect;
    return NSMakeRect(frame[0], frame[1], frame[2], frame[3]);
}

void *producer_studio_stage_preview_create(void *window, const double normalized[4],
                                          double *width, double *height) {
    if (!window || !normalized || !width || !height) return NULL;
    // The capture configuration excludes child windows on macOS 14.2 and up.
    // The room's clean preview remains underneath for ScreenCaptureKit.
    if (@available(macOS 14.2, *)) {
        __block void *drawable = NULL;
        preview_main(^{
            NSWindow *host = (__bridge NSWindow *)window;
            NSRect frame = stage_frame(host, normalized);
            if (NSIsEmptyRect(frame)) return;
            NSPanel *panel = [[NSPanel alloc] initWithContentRect:frame
                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                backing:NSBackingStoreBuffered defer:NO];
            if (!panel) return;
            panel.releasedWhenClosed = NO;
            panel.becomesKeyOnlyIfNeeded = YES;
            panel.hidesOnDeactivate = YES;
            panel.hasShadow = NO;
            panel.excludedFromWindowsMenu = YES;
            panel.ignoresMouseEvents = YES;
            panel.collectionBehavior = NSWindowCollectionBehaviorFullScreenAuxiliary |
                                       NSWindowCollectionBehaviorIgnoresCycle;
            panel.animationBehavior = NSWindowAnimationBehaviorNone;
            panel.backgroundColor = NSColor.blackColor;

            ProducerStudioStageView *view = [[ProducerStudioStageView alloc]
                initWithFrame:NSMakeRect(0, 0, NSWidth(frame), NSHeight(frame))];
            view.wantsLayer = YES;
            view.layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
            view.layer.masksToBounds = YES;
            view.hostWindow = host;
            view.previewPanel = panel;
            view.requested = YES;
            view.positioned = YES;
            panel.contentView = view;
            panel.delegate = view;
            // The initial frame is in screen coordinates, including on a
            // secondary display. AppKit tracks origin changes after attachment.
            [panel setFrame:frame display:NO];
            [view observeHost];

            NSSize pixels = [view convertRectToBacking:view.bounds].size;
            *width = round(pixels.width);
            *height = round(pixels.height);
            view.displaySize = NSMakeSize(*width, *height);
            drawable = (void *)CFBridgingRetain(view);
        });
        return drawable;
    }
    return NULL;
}

void producer_studio_stage_preview_bind(void *drawable, struct obs_display *display) {
    preview_main(^{
        ProducerStudioStageView *view = (__bridge ProducerStudioStageView *)drawable;
        if (!display) {
            view.requested = NO;
            [view refreshVisibility];
        }
        view.display = display;
        [view refreshDisplaySize];
        [view refreshVisibility];
    });
}

bool producer_studio_stage_preview_move(void *drawable, const double normalized[4]) {
    __block bool positioned = false;
    preview_main(^{
        ProducerStudioStageView *view = (__bridge ProducerStudioStageView *)drawable;
        NSRect frame = stage_frame(view.hostWindow, normalized);
        view.positioned = !NSIsEmptyRect(frame);
        if (view.positioned) {
            if (!NSEqualRects(view.previewPanel.frame, frame))
                [view.previewPanel setFrame:frame display:NO];
            view.requested = YES;
            [view refreshDisplaySize];
            positioned = true;
        }
        [view refreshVisibility];
    });
    return positioned;
}

void producer_studio_stage_preview_hide(void *drawable) {
    preview_main(^{
        ProducerStudioStageView *view = (__bridge ProducerStudioStageView *)drawable;
        view.requested = NO;
        [view refreshVisibility];
    });
}

void producer_studio_preview_show(void *drawable) {
    if (!drawable) return;
    preview_main(^{
        ProducerStudioPreviewView *view = (__bridge ProducerStudioPreviewView *)drawable;
        if (!atomic_load_explicit(&view->closed, memory_order_acquire)) {
            [view.previewPanel orderFront:nil];
        }
    });
}

bool producer_studio_preview_is_closed(void *drawable) {
    ProducerStudioPreviewView *view = (__bridge ProducerStudioPreviewView *)drawable;
    return !view || atomic_load_explicit(&view->closed, memory_order_acquire);
}

bool producer_studio_preview_floating(void *drawable) {
    ProducerStudioPreviewView *view = (__bridge ProducerStudioPreviewView *)drawable;
    return view && atomic_load_explicit(&view->floating, memory_order_acquire);
}

void producer_studio_preview_set_floating(void *drawable, bool floating) {
    if (!drawable) return;
    preview_main(^{
        ProducerStudioPreviewView *view = (__bridge ProducerStudioPreviewView *)drawable;
        view.framingControl.selectedSegment = floating ? 1 : 0;
        atomic_store_explicit(&view->floating, floating, memory_order_release);
    });
}

void producer_studio_preview_destroy(void *drawable) {
    if (!drawable) return;
    preview_main(^{
        ProducerStudioPreviewView *view = CFBridgingRelease(drawable);
        NSPanel *panel = view.previewPanel;
        [NSNotificationCenter.defaultCenter removeObserver:view];
        [panel.parentWindow removeChildWindow:panel];
        panel.delegate = nil;
        [panel close];
        view.previewPanel = nil;
    });
}
