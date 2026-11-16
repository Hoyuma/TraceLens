# X11 への実入力（XTest）。ブラウザのツールバーなど、CDP では操作できない箇所の検証用。
# 使い方: python3 xinput.py move X Y | click X Y | key alt+shift+s
import ctypes, sys, time
x = ctypes.CDLL('libX11.so.6'); t = ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XStringToKeysym.restype = ctypes.c_ulong
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
d = x.XOpenDisplay(None)
if not d: sys.exit('no display')
for f in (t.XTestFakeMotionEvent, t.XTestFakeButtonEvent, t.XTestFakeKeyEvent, x.XFlush, x.XSync): f.argtypes = None
def flush(): x.XFlush(ctypes.c_void_p(d)); time.sleep(0.08)
def move(px, py): t.XTestFakeMotionEvent(ctypes.c_void_p(d), -1, int(px), int(py), 0); flush()
cmd = sys.argv[1]
if cmd in ('move', 'click'):
    move(sys.argv[2], sys.argv[3])
    if cmd == 'click':
        t.XTestFakeButtonEvent(ctypes.c_void_p(d), 1, 1, 0); flush()
        t.XTestFakeButtonEvent(ctypes.c_void_p(d), 1, 0, 0); flush()
elif cmd == 'key':
    names = {'alt': 'Alt_L', 'shift': 'Shift_L', 'ctrl': 'Control_L'}
    codes = [x.XKeysymToKeycode(d, x.XStringToKeysym(names.get(k, k).encode())) for k in sys.argv[2].split('+')]
    for c in codes: t.XTestFakeKeyEvent(ctypes.c_void_p(d), c, 1, 0); flush()
    for c in reversed(codes): t.XTestFakeKeyEvent(ctypes.c_void_p(d), c, 0, 0); flush()
