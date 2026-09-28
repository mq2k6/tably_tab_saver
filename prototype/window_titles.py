"""List titles of windows on the current Windows virtual desktop.

Original Tably prototype. Requires: pip install pygetwindow pyvda
"""
import pygetwindow as gw
from pyvda import AppView, VirtualDesktop


def get_windows_on_current_desktop():
    current = VirtualDesktop.current().number
    titles = []
    for w in gw.getAllWindows():
        if not w.title:
            continue
        try:
            if AppView(w._hWnd).desktop.number == current:
                titles.append(w.title)
        except Exception:
            pass  # some system/hidden windows aren't tracked by pyvda
    return titles


if __name__ == "__main__":
    for title in get_windows_on_current_desktop():
        print(title)
