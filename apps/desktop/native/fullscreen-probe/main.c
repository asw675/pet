#include <windows.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <stdint.h>
#include <stdio.h>

typedef enum { CLEAR, UNKNOWN, GLOBAL, DISPLAY } Scope;

typedef struct {
    Scope scope;
    LONG x;
    LONG y;
} Observation;

static Observation without_point(Scope scope) {
    Observation result = {scope, 0, 0};
    return result;
}

/* Match all monitor edges in physical pixels. An oversized or multi-monitor
 * window is not a single-monitor fullscreen window. */
static BOOL near_edge(LONG first, LONG second) {
    const int64_t delta = (int64_t)first - second;
    return delta >= -2 && delta <= 2;
}

static BOOL fills_monitor(const RECT *window, const RECT *monitor) {
    return near_edge(window->left, monitor->left) && near_edge(window->top, monitor->top)
        && near_edge(window->right, monitor->right) && near_edge(window->bottom, monitor->bottom);
}

static Observation display_point(const RECT *monitor) {
    Observation result = {DISPLAY,
        (LONG)((int64_t)monitor->left + ((int64_t)monitor->right - monitor->left) / 2),
        (LONG)((int64_t)monitor->top + ((int64_t)monitor->bottom - monitor->top) / 2)};
    return result;
}

static Observation foreground(BOOL physical_coordinates) {
    QUERY_USER_NOTIFICATION_STATE shell_state;
    const HRESULT shell_result = SHQueryUserNotificationState(&shell_state);
    const BOOL has_shell_state = SUCCEEDED(shell_result);
    if (has_shell_state && shell_state == QUNS_PRESENTATION_MODE) return without_point(GLOBAL);
    const BOOL exclusive = has_shell_state && shell_state == QUNS_RUNNING_D3D_FULL_SCREEN;
    const Scope indeterminate = exclusive ? GLOBAL : UNKNOWN;
    if (!physical_coordinates || (has_shell_state && shell_state == QUNS_NOT_PRESENT)) return without_point(indeterminate);

    const HWND window = GetForegroundWindow();
    if (!window || !IsWindowVisible(window) || IsIconic(window)) return without_point(indeterminate);
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0)
        return without_point(indeterminate);
    if (window == GetDesktopWindow() || window == GetShellWindow()) return without_point(exclusive ? GLOBAL : CLEAR);

    const HMONITOR handle = MonitorFromWindow(window, MONITOR_DEFAULTTONULL);
    MONITORINFO monitor = {0};
    monitor.cbSize = sizeof(monitor);
    if (!handle || !GetMonitorInfoW(handle, &monitor)) return without_point(indeterminate);

    const Observation display = display_point(&monitor.rcMonitor);
    if (exclusive) return GetForegroundWindow() == window ? display : without_point(GLOBAL);

    /* DWM's extended bounds omit invisible resize borders and use physical
     * pixels. The fallback is only used in the per-monitor-aware process. */
    RECT frame;
    if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame)))
        && !GetWindowRect(window, &frame)) return without_point(UNKNOWN);
    SetLastError(ERROR_SUCCESS);
    const LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
    if ((style == 0 && GetLastError() != ERROR_SUCCESS) || GetForegroundWindow() != window) return without_point(UNKNOWN);

    /* A regular framed maximized window can cover a monitor with an
     * auto-hidden taskbar. Fullscreen video and games use a borderless frame. */
    if ((style & WS_CAPTION) == WS_CAPTION || !fills_monitor(&frame, &monitor.rcMonitor)) return without_point(CLEAR);
    return display;
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) return 2;
    const BOOL dpi = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
        || AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    /* One byte per sample. EOF stops the helper when Main closes its pipe.
     * The response never includes an HWND, window title, process ID or image. */
    int request;
    while ((request = getchar()) != EOF) {
        if (request != '?') return 2;
        const Observation observed = foreground(dpi);
        int written;
        switch (observed.scope) {
            case CLEAR: written = puts("1 CLEAR"); break;
            case UNKNOWN: written = puts("1 UNKNOWN"); break;
            case GLOBAL: written = puts("1 GLOBAL"); break;
            case DISPLAY: written = printf("1 DISPLAY %ld %ld\n", observed.x, observed.y); break;
            default: return 2;
        }
        if (written < 0 || fflush(stdout) == EOF) return 3;
    }
    return ferror(stdin) ? 3 : 0;
}
