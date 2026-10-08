// The Producer window's native glass base coat. Kept separate from the OBS
// shim so engine-less development builds have the same rail as release apps.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

static NSView *find_webview(NSView *view) {
    if ([view isKindOfClass:[WKWebView class]]) return view;
    for (NSView *sub in view.subviews) {
        NSView *found = find_webview(sub);
        if (found) return found;
    }
    return nil;
}

static NSVisualEffectView *find_vibrancy(NSView *content) {
    for (NSView *sub in content.subviews) {
        if ([sub isKindOfClass:[NSVisualEffectView class]]) return (NSVisualEffectView *)sub;
    }
    return nil;
}

int producer_apply_window_vibrancy(void *ns_window) {
    __block int ok = 0;
    void (^apply)(void) = ^{
        NSWindow *win = (__bridge NSWindow *)ns_window;
        if (!win) return;
        NSView *content = win.contentView;
        if (!content) return;
        win.opaque = NO;
        win.backgroundColor = [NSColor clearColor];
        if (!find_vibrancy(content)) {
            NSVisualEffectView *effect = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
            effect.material = NSVisualEffectMaterialHUDWindow;
            effect.blendingMode = NSVisualEffectBlendingModeBehindWindow;
            effect.state = NSVisualEffectStateActive;
            effect.appearance = [NSAppearance appearanceNamed:NSAppearanceNameVibrantDark];
            effect.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
            [content addSubview:effect positioned:NSWindowBelow relativeTo:nil];
        }
        WKWebView *webview = (WKWebView *)find_webview(content);
        if (webview) {
            @try {
                [webview setValue:@NO forKey:@"drawsBackground"];
            } @catch (NSException *exception) {
                (void)exception;
            }
            if (@available(macOS 12.0, *)) {
                webview.underPageBackgroundColor = [NSColor clearColor];
            }
        }
        ok = 1;
    };
    if ([NSThread isMainThread]) apply();
    else dispatch_sync(dispatch_get_main_queue(), apply);
    return ok;
}
