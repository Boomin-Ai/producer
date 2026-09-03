/* Win32 half of src/live/shim.m.
 *
 * ffi.rs declares one set of `producer_*` symbols for every platform, so this
 * file exports exactly the same names with exactly the same signatures. Rust
 * above it is unchanged; only the bodies differ.
 *
 * ── What is REAL here ────────────────────────────────────────────────────────
 *   producer_preview_attach / set_frame / set_hidden / detach
 *       A child HWND over the WebView2 window. libobs takes an HWND directly in
 *       gs_init_data.window on Windows, exactly as it takes an NSView on macOS,
 *       so the preview path is a genuine port rather than a stub.
 *
 * ── What is DELIBERATELY a no-op, and why ────────────────────────────────────
 *   producer_apply_window_vibrancy      macOS glass is a design choice, not a
 *                                       feature gap. tauri.macos.conf.json holds
 *                                       the transparent window, so the Windows
 *                                       base config is already solid — returning
 *                                       0 here is the correct outcome, not a TODO.
 *   producer_preview_prepare_window     The transparent-hole mode is macOS-only.
 *                                       Float mode is the whole Windows story for
 *                                       now and the room UI fully supports it.
 *   producer_av_*, screen_capture_*     Windows has no TCC. It prompts per-app at
 *                                       CAPTURE time, so "already authorised" is
 *                                       the truthful answer, not an optimistic one.
 *   producer_vcam_activate / _state     No system extension. On Windows the
 *                                       virtual camera is win-dshow's DirectShow
 *                                       filter, registered by the installer
 *                                       (regsvr32), not activated at runtime.
 *   producer_open_*_settings            Deep links into Windows Settings, which
 *                                       genuinely exist — see below.
 *   producer_drag_chip_*                A macOS drag affordance with no Windows
 *                                       counterpart yet.
 *
 * Every no-op returns the value that keeps the caller on its happy path. A stub
 * that reports "denied" would make the UI show a permission wall for a
 * permission system that does not exist here.
 */

#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#define PRODUCER_PREVIEW_CLASS L"ProducerPreviewHost"

static ATOM g_preview_class = 0;

/* The preview child paints nothing itself — libobs renders into it. Returning
 * 1 from WM_ERASEBKGND stops Windows painting white behind the swapchain, which
 * is what causes a flash on resize. */
/* The window the room UI actually reads input from: the deepest visible
 * sibling-or-descendant under a screen point, skipping the preview itself.
 * In practice WRY_WEBVIEW -> Chrome_WidgetWin_1 -> Chrome_RenderWidgetHostHWND. */
static HWND input_target_under(HWND self, POINT screen_pt)
{
    HWND parent = GetParent(self);
    if (!parent)
        return NULL;
    HWND hit = NULL;
    for (HWND w = GetWindow(parent, GW_CHILD); w; w = GetWindow(w, GW_HWNDNEXT)) {
        if (w == self || !IsWindowVisible(w))
            continue;
        RECT r;
        if (GetWindowRect(w, &r) && PtInRect(&r, screen_pt)) {
            hit = w;
            break;
        }
    }
    if (!hit)
        return NULL;
    /* descend to the innermost child that contains the point */
    for (;;) {
        POINT cp = screen_pt;
        ScreenToClient(hit, &cp);
        HWND deeper = ChildWindowFromPointEx(hit, cp, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED);
        if (!deeper || deeper == hit)
            return hit;
        hit = deeper;
    }
}

static LRESULT CALLBACK preview_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    if (msg == WM_ERASEBKGND)
        return 1;

    /* INPUT FORWARDING. In float mode this child sits ABOVE the webview, so it
     * receives every click inside the stage -- and the room's item drag lives
     * in the webview. Returning HTTRANSPARENT was tried: the hit falls to the
     * PARENT window, which takes focus from WebView2, and the webview goes deaf
     * until something re-focuses it. So instead: keep the hit, find the
     * webview's input window beneath the point, focus it, and re-post the
     * message there with translated coordinates. The preview never wants input
     * itself; every interaction with the stage belongs to the room UI. */
    switch (msg) {
    case WM_MOUSEMOVE:
    case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_LBUTTONDBLCLK:
    case WM_RBUTTONDOWN: case WM_RBUTTONUP: case WM_RBUTTONDBLCLK:
    case WM_MBUTTONDOWN: case WM_MBUTTONUP: {
        POINT pt = { (short)LOWORD(lp), (short)HIWORD(lp) };
        ClientToScreen(hwnd, &pt);
        HWND target = input_target_under(hwnd, pt);
        if (target) {
            if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN)
                SetFocus(target);
            POINT cp = pt;
            ScreenToClient(target, &cp);
            PostMessageW(target, msg, wp, MAKELPARAM((short)cp.x, (short)cp.y));
        }
        return 0;
    }
    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL: {
        /* wheel messages carry SCREEN coordinates already */
        POINT pt = { (short)LOWORD(lp), (short)HIWORD(lp) };
        HWND target = input_target_under(hwnd, pt);
        if (target)
            PostMessageW(target, msg, wp, lp);
        return 0;
    }
    case WM_SETCURSOR:
        /* let the window beneath decide the cursor; ours is never the answer */
        return DefWindowProcW(hwnd, msg, wp, lp);
    default:
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
}

static void ensure_class(void)
{
    if (g_preview_class)
        return;
    WNDCLASSEXW wc = {0};
    wc.cbSize = sizeof(wc);
    /* CS_OWNDC: libobs keeps a device context for the swapchain's lifetime. */
    wc.style = CS_HREDRAW | CS_VREDRAW | CS_OWNDC;
    wc.lpfnWndProc = preview_wndproc;
    wc.hInstance = GetModuleHandleW(NULL);
    wc.hCursor = LoadCursorW(NULL, IDC_ARROW);
    wc.lpszClassName = PRODUCER_PREVIEW_CLASS;
    g_preview_class = RegisterClassExW(&wc);
}

/* Points → physical pixels. The caller lays out in logical units (it is driven
 * by a webview), and libobs wants real pixels, so every geometry call reports
 * both. Per-monitor DPI: a window dragged to a second display with different
 * scaling must re-report, which is why this is read per call rather than cached. */
static double scale_for(HWND hwnd)
{
    UINT dpi = GetDpiForWindow(hwnd);
    if (dpi == 0)
        dpi = 96;
    return (double)dpi / 96.0;
}

void *producer_preview_attach(void *ns_window, double x, double y, double w, double h,
                              int below_webview, double *out_px_w, double *out_px_h)
{
    HWND parent = (HWND)ns_window;
    if (!parent || !IsWindow(parent))
        return NULL;

    ensure_class();
    if (!g_preview_class)
        return NULL;

    const double s = scale_for(parent);
    HWND child = CreateWindowExW(
        /* No WS_EX_LAYERED: a layered child cannot host a D3D swapchain. */
        0, PRODUCER_PREVIEW_CLASS, L"",
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
        (int)(x * s), (int)(y * s), (int)(w * s), (int)(h * s),
        parent, NULL, GetModuleHandleW(NULL), NULL);
    if (!child)
        return NULL;

    /* Float mode places the preview ABOVE the webview; below_webview is the
     * macOS transparent-hole arrangement, which we do not implement yet. We
     * honour the argument for z-order rather than ignoring it, so the Rust side
     * behaves identically on both platforms even though only one mode is wired. */
    HWND after = below_webview ? HWND_BOTTOM : HWND_TOP;
    SetWindowPos(child, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

    if (out_px_w)
        *out_px_w = w * s;
    if (out_px_h)
        *out_px_h = h * s;
    return (void *)child;
}

void producer_preview_set_frame(void *view_ptr, double x, double y, double w, double h,
                                double *out_px_w, double *out_px_h)
{
    HWND child = (HWND)view_ptr;
    if (!child || !IsWindow(child))
        return;

    HWND parent = GetParent(child);
    const double s = scale_for(parent ? parent : child);
    SetWindowPos(child, NULL, (int)(x * s), (int)(y * s), (int)(w * s), (int)(h * s),
                 SWP_NOZORDER | SWP_NOACTIVATE);

    if (out_px_w)
        *out_px_w = w * s;
    if (out_px_h)
        *out_px_h = h * s;
}

void producer_preview_set_hidden(void *view_ptr, int hidden)
{
    HWND child = (HWND)view_ptr;
    if (child && IsWindow(child))
        ShowWindow(child, hidden ? SW_HIDE : SW_SHOWNA);
}

void producer_preview_detach(void *view_ptr)
{
    HWND child = (HWND)view_ptr;
    if (child && IsWindow(child))
        DestroyWindow(child);
}

/* macOS-only: prepares the window for the transparent-hole preview mode. */
int producer_preview_prepare_window(void *ns_window)
{
    (void)ns_window;
    return 0;
}

/* macOS-only by design — see the header note. */
int producer_apply_window_vibrancy(void *ns_window)
{
    (void)ns_window;
    return 0;
}

/* ── Permissions ─────────────────────────────────────────────────────────────
 * Windows has no TCC. Capture APIs prompt per-app at first use, and there is no
 * queryable pre-authorisation state. 3 is the AUTHORIZED value the macOS side
 * returns (AVAuthorizationStatusAuthorized), so reporting it keeps the UI on the
 * same path rather than showing a permission wall for a system that is absent. */
int producer_av_authorization_status(int media_type)
{
    (void)media_type;
    return 3;
}

void producer_av_request_access(int media_type)
{
    (void)media_type;
}

int producer_screen_capture_preflight(void)
{
    return 1;
}

void producer_screen_capture_request(void) {}

/* ── Device + window enumeration ─────────────────────────────────────────────
 * Both return a count and fill a caller-owned buffer, same contract as macOS.
 *
 * The camera default is left to the plugin: win-dshow enumerates DirectShow
 * devices itself and an empty id means "first available", which is the same
 * outcome the macOS path produces without duplicating enumeration here. */
int producer_default_camera_id(char *buf, int buflen)
{
    if (buf && buflen > 0)
        buf[0] = '\0';
    return 0;
}

/* Visible, titled, non-minimised top-level windows — the capture picker's list.
 * JSON to match the macOS shim's contract exactly. */
struct window_collect {
    char *buf;
    int buflen;
    int written;
    int count;
};

static BOOL CALLBACK collect_window(HWND hwnd, LPARAM lparam)
{
    struct window_collect *c = (struct window_collect *)lparam;

    if (!IsWindowVisible(hwnd) || IsIconic(hwnd))
        return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != NULL)
        return TRUE;

    /* Skip cloaked windows — UWP keeps invisible shells around that would
     * otherwise appear in the picker as unselectable ghosts. */
    BOOL cloaked = FALSE;
    typedef HRESULT(WINAPI * dwm_get_attr)(HWND, DWORD, PVOID, DWORD);
    static dwm_get_attr get_attr = NULL;
    static int resolved = 0;
    if (!resolved) {
        HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
        if (dwm)
            get_attr = (dwm_get_attr)GetProcAddress(dwm, "DwmGetWindowAttribute");
        resolved = 1;
    }
    if (get_attr && SUCCEEDED(get_attr(hwnd, 14 /* DWMWA_CLOAKED */, &cloaked, sizeof(cloaked))) && cloaked)
        return TRUE;

    wchar_t wtitle[512];
    int wlen = GetWindowTextW(hwnd, wtitle, 512);
    if (wlen <= 0)
        return TRUE;

    char title[1024];
    int len = WideCharToMultiByte(CP_UTF8, 0, wtitle, wlen, title, sizeof(title) - 1, NULL, NULL);
    if (len <= 0)
        return TRUE;
    title[len] = '\0';

    /* Escape for JSON. Only quote and backslash can appear in a window title in
     * a way that would break the document; control characters are dropped. */
    char esc[2048];
    int e = 0;
    for (int i = 0; i < len && e < (int)sizeof(esc) - 2; i++) {
        unsigned char ch = (unsigned char)title[i];
        if (ch == '"' || ch == '\\') {
            esc[e++] = '\\';
            esc[e++] = (char)ch;
        } else if (ch >= 0x20) {
            esc[e++] = (char)ch;
        }
    }
    esc[e] = '\0';

    char entry[2200];
    int n = snprintf(entry, sizeof(entry), "%s{\"id\":%llu,\"title\":\"%s\"}",
                     c->count ? "," : "", (unsigned long long)(uintptr_t)hwnd, esc);
    if (n < 0)
        return TRUE;
    /* +1 leaves room for the closing bracket the caller appends. */
    if (c->buf && c->written + n < c->buflen - 1) {
        memcpy(c->buf + c->written, entry, (size_t)n);
        c->written += n;
    }
    c->count++;
    return TRUE;
}

int producer_list_windows(char *buf, int buflen)
{
    if (!buf || buflen < 3)
        return 0;

    struct window_collect c = {buf, buflen, 1, 0};
    buf[0] = '[';
    EnumWindows(collect_window, (LPARAM)&c);
    if (c.written < buflen - 1) {
        buf[c.written++] = ']';
        buf[c.written] = '\0';
    } else {
        buf[buflen - 2] = ']';
        buf[buflen - 1] = '\0';
    }
    return c.count;
}

/* ── Settings deep links ─────────────────────────────────────────────────────
 * These URIs are real and stable across Windows 10/11. ShellExecute is
 * fire-and-forget: a failure means the user opens Settings themselves, which is
 * not worth surfacing as an error. */
static void open_settings(const wchar_t *uri)
{
    ShellExecuteW(NULL, L"open", uri, NULL, NULL, SW_SHOWNORMAL);
}

void producer_open_screen_settings(void)
{
    /* Windows has no screen-recording permission; this is the closest surface. */
    open_settings(L"ms-settings:privacy-general");
}

void producer_open_camera_settings(void)
{
    open_settings(L"ms-settings:privacy-webcam");
}

void producer_open_mic_settings(void)
{
    open_settings(L"ms-settings:privacy-microphone");
}

/* ── Virtual camera ──────────────────────────────────────────────────────────
 * On macOS this drives OSSystemExtensionManager. On Windows the virtual camera
 * is win-dshow's DirectShow filter, registered by the installer, so there is
 * nothing to activate at runtime.
 *
 * producer_vcam_installed reports 0 until the win-dshow virtual camera ships —
 * the last rung of the ladder. Reporting 1 would make the UI offer a button
 * that silently does nothing, which is worse than an honestly absent feature. */
void producer_vcam_activate(void) {}

/* CONTRACT: the return value is the STATE CODE and buf receives an ERROR
 * STRING — not, as a first pass here assumed, a JSON blob. Writing JSON into
 * buf made vcam_status() read its length (22) as the state, fall through to
 * "idle", and surface the JSON as an error; the UI then offered an Install
 * button wired to a no-op. 5 is the Windows-only "unsupported" code, added to
 * the match in live/mod.rs, and the buffer stays empty because there is no
 * error to report — the feature simply does not exist here yet. */
int producer_vcam_state(char *buf, int len)
{
    if (buf && len > 0)
        buf[0] = 0; /* NUL terminator: no error to report */
    return 5;
}

int producer_vcam_installed(void)
{
    return 0;
}

/* macOS drag affordance; no Windows counterpart yet. */
void producer_drag_chip_show(void) {}
void producer_drag_chip_hide(void) {}
