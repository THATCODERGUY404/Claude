# SwingLab – golf swing analysis

A phone app for frame-by-frame golf swing analysis, built along the lines of OnForm or Kinovea.
It's a **Progressive Web App** (a website you can install like an app): it runs in Safari on iPhone and in Chrome on Android,
can be added to the home screen, works offline, and keeps every video **on the device** (in IndexedDB). There is no server, account or upload.

## Features
- **Record or import** swings. *Record* opens the phone's native camera, so you can use slow-mo (120/240 fps).
- **Frame-accurate playback**: play/pause, single-frame step, a drag "jog wheel" to scrub frame by frame, a timeline, and speeds of 1×, ½×, ¼× and 0.1×.
- **Frame-rate detection** (when the browser supports it). Tap the fps pill to set it yourself, e.g. 240 for slow-mo.
- **Drawing tools**: line (shows its tilt in degrees), swing **plane** line (extends across the whole frame), **angle** (3 points, shows degrees), circle, box, arrow and freehand, in 6 colours. Drag any handle to adjust a drawing. Also erase, undo and clear.
- **Pinch to zoom and pan** (or use the mouse wheel and drag). Double-tap or *Fit* resets the view. Drawings stay attached to the video while you zoom.
- **Grid** and **mirror** (flip to compare a left-handed and a right-handed golfer).
- **Swing phases**: Address, Top, Impact and Finish. Long-press a chip to mark the current frame; tap it to jump there.
  The app then shows **tempo** (backswing : downswing ratio, about 3:1 for most tour players) and loops Address→Finish.
- **Compare two swings** side by side or stacked (it picks whichever shows more video), or **overlay** them with adjustable opacity.
  **Link** plays and steps both together, and lines them up on Impact (or Top or Address) when both swings have that phase marked.
- **Snapshot** saves the current frame with its drawings at full resolution to the share sheet or downloads.
- Drawings and phase markers are saved automatically for each swing.
- Desktop shortcuts: `Space` play/pause, `←/→` step one frame, `Shift+←/→` step 10 frames, `Ctrl/Cmd+Z` undo.

## Run it
It's plain HTML, CSS and JavaScript with no build step. Serve the folder over HTTP:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

To use it on your phone, host it over **HTTPS**. Installing and offline support need HTTPS.
The included workflow (`.github/workflows/pages.yml`) deploys to GitHub Pages whenever you push to `main` (or the current default branch, `claude/golf-swing-analysis-app-h25scv`).
Turn it on under *Settings → Pages → Source: GitHub Actions*.
Then open the URL on your phone and choose *Share → Add to Home Screen* (iOS) or *Install app* (Android).

## Project layout
| File | Purpose |
|---|---|
| `index.html` | App shell: library, analyzer and compare picker |
| `js/app.js` | Views, library, transport, phases/tempo, compare/link, snapshot |
| `js/pane.js` | A single video viewport: zoom/pan, frame stepping, fps detection, drawing interaction |
| `js/shapes.js` | Shape rendering, angle maths and hit-testing |
| `js/db.js` | IndexedDB storage |
| `sw.js`, `manifest.webmanifest` | Offline cache and install metadata |
| `tests/smoke.cjs` | Playwright end-to-end test |

## Testing
```bash
python3 -m http.server 8123 &
ffmpeg -f lavfi -i testsrc2=size=360x640:rate=60:duration=3 -c:v libvpx-vp9 a.webm
ffmpeg -f lavfi -i smptebars=size=360x640:rate=30:duration=2 -c:v libvpx-vp9 b.webm
node tests/smoke.cjs a.webm b.webm /tmp
```

## Ideas for next steps
- Automatic body-pose overlay (e.g. MediaPipe Pose) for spine angle, head movement and hip sway
- Drawings that only appear on certain frames (keyframes)
- Voice-over / screen recording of a lesson
- Wrapping it with Capacitor to ship as an App Store / Play Store app
