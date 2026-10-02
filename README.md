# Video Duplicate Finder for Eagle

An [Eagle](https://eagle.cool) plugin that finds duplicate and near-duplicate videos and images in
your Eagle library: re-encodes, resized copies, crops, watermarks, mirrored copies, and clips cut out
of longer videos. It is a port of [Video Duplicate Finder](https://github.com/0x90d/videoduplicatefinder)
(VDF) by 0x90d. The matching engine reproduces VDF's algorithms (grayscale frame compare, pHash,
audio fingerprints, the DINOv2 AI pass), and everything around it is rebuilt on Eagle's own items,
folders, tags, ratings and trash.

Nothing in your library changes until you choose an action in Results. Actions that change
several items ask first and list exactly what they will change. Trash goes to Eagle's trash, and
the last action can be undone.

## Install

1. Get the `.eagleplugin` file from the
   [Releases](https://github.com/Kristijan1001/eagle-video-duplicate-finder/releases) page, or build
   it yourself (see [Building](#building)).
2. Double-click it, or drag it onto Eagle. Eagle installs it under **Plugins**.
3. On first start the plugin asks for Eagle's official **FFmpeg** module if it is missing and
   installs it through Eagle.

To run it from source instead, use **Plugins → Developer options → Import local project** and
select the `plugin` folder.

Requirements: Eagle 4 on **Windows x64** (tested with Eagle 4.0 build 23 on Windows 11). This
release is built for Windows x64 only.

## Using it

**Scan** picks what to compare:

| Scope | What gets compared |
|---|---|
| Whole library | every video and image against every other |
| Selected items | the items selected in Eagle when you press Start |
| Folders | a folder tree picker (subfolders included unless you switch that off) |
| Smart folders | the items of the chosen smart folders |
| Tags | items carrying any (or all) of the chosen tags |

The *Leave out* card excludes folders and tags, and file types. *Also compare against the rest of
the library* keeps the scope as the thing you are cleaning, but matches it against everything.
Scopes are remembered per library.

Profiles set the matching options in one click: **Exact & near copies** (98%), **Edited & altered**
(92%, mirrored copies, default), **AI scan** (adds DINOv2 matching and AI partial clips) and
**Deep clean** (everything, plus audio-fingerprint clip detection). Every VDF option is also
available on its own in Settings.

The first scan reads each file once. On a hard drive that takes a while, and it can be paused,
stopped and resumed. Later scans only read new or changed files. If you close the window during a
scan, it drops to the taskbar and the scan keeps going.

**Results** lists the duplicate groups with Eagle thumbnails, the compared frames, resolution,
bitrate, codec, duration, size, folders, tags and rating. The best copy in each group is marked.

- **Select** has lowest quality (with an editable criteria order), identical copies, identical
  except size, oldest, newest, live copies of previously deleted content, custom selection
  (size, similarity, date, path and folder patterns, with presets), and select-by-expression using
  VDF's C#-style expressions (`item.Duration.Minutes > 15`, `item.Tags.Contains("keep")`).
  Expressions are parsed, never executed as code.
- After each scan the plugin can check copies on its own, as VDF does: with a custom selection
  preset (Settings → Results), and for live copies of content you trashed before (Settings →
  Scope & files, *Remember deleted content*). This only sets check marks.
- **Actions** covers moving checked items to Eagle trash, optionally merging tags, folders,
  rating, annotation and source URL into the kept copy first. You can also tag, add or move to a
  folder, export copies to disk, rename, mark groups "not a match" (hidden in future scans), remove
  from the list or exclude from future scans, save a dry-run report, and export results as
  JSON/CSV/HTML.
- Trashing, moving or adding to a folder, and tagging ask first. The confirmation shows how many
  items change, lists them, and for a move shows each item's current folders next to the new one
  (moving replaces an item's folders; adding keeps them). Focus starts on **Cancel**, so Enter
  never confirms. **Don't ask again** turns one confirmation off; Settings → Confirmations turns
  it back on. Trashing every copy of a group always asks.
- **Compare** (`C`, double-click, or the group's compare button) shows two files of a group
  in Single, Swipe, Side by side or Stacked view:
  - It plays both in sync, steps both a frame or a second at a time, and scrubs a timeline
    marked with the sampled frames.
  - You can offset one file by single frames to line them up, and zoom and pan both at once.
  - **Highlight differences** draws VDF's boxes around regions that differ structurally.
    Brightness and colour-grade shifts are ignored.
  - Under each file are its resolution, size, video bitrate and audio chips. Resolution, size
    and video bitrate turn green or red against the other file.
  - Mirrored copies are shown mirrored. Clips are aligned to the matched time in their source.
  - A file the built-in player can't decode (for example AVI with MPEG-4) is shown with
    frames from FFmpeg, and only playback is off for it.
  - Deciding works like VDF's winner-stays walk: **Keep left, check right** (`A`), **Keep
    right, check left** (`D`), **Skip** (`S`) and **Not a match** (`N`), moving on to the next
    group when one is done (`PageUp` / `PageDown` switch groups).
  - Other keys: `Space` play/pause, `←` `→` one frame, `Shift` + arrows sampled frame,
    `Ctrl` + arrows one second, `[` `]` offset B, `Z` zoom, `X` switch A/B in Single view.
- **Compare metadata** shows the files' metadata side by side. **Why do these match?** runs the
  matching maths on one pair.
- Hovering a sampled frame shows it large, with the same difference boxes against the group's
  best-resolution copy. It opens instantly and sharpens a moment later.
- Hovering duration, resolution, bitrate, fps or size shows every value in the group as its
  difference to the best one, like VDF. **Compare values with the best** in a row's menu keeps
  those differences shown.
- Keyboard: `↑ ↓` move, `Space` check, `K` keep this one and go to the next group, `Enter` open,
  `C` compare, `Del` trash checked (asks first), `Ctrl+Z` undo selection, `Ctrl+F` filter,
  `Ctrl+1…5` switch pages.

**Database** shows the fingerprint cache for the current library. From there you can clean it up,
retry failed files, export or import it as JSON, clear it, and manage excluded items and "not a
match" groups. **Log** shows everything the engine reports.

## Two thresholds when AI is on

As in VDF, the AI pass has its own threshold (**AI similarity threshold**, default 94%). It sits
right under the AI matching switch on the Scan page. A pair that fails the similarity threshold
is still reported when its AI similarity reaches that value. So with the similarity threshold
at 100% and AI on, you still get AI matches from 94% up; they are labelled **AI**. To get
identical copies only, turn AI matching off or raise the AI threshold to 100%.

## Tuning for dark footage

VDF's default (grayscale at 92%, one frame per video) compares tiny 32×32 frames. On dark
material, such as 3D renders on black backgrounds, the few pixels left after ignoring black can
be close enough between *different* videos to pass 92%. On a 400-item sample of a real animation
library, the default found 8 groups, 5 of them different videos with mostly dark frames. Their
pHash distances were 24–34 of 64 bits, against 0 for the true duplicate. Switching **Settings →
Matching → Algorithm** to **pHash**, or raising the threshold to 96%, removed all five and kept
the true duplicate. Fingerprints are cached, so trying another setting does not read the files
again.

## Where data is kept

The plugin never writes into the Eagle library folder. Its data lives in
`%LOCALAPPDATA%\VDF for Eagle` (macOS: `~/Library/Application Support/VDF for Eagle`):

| Path | Contents |
|---|---|
| `settings.json` | all settings (scan scopes per library) |
| `libraries\<library>-<hash>\` | that library's fingerprint cache, thumbnails, last results, undo data, "not a match" list |
| `ai\` | the DINOv2 model, only if you enable AI matching |

*Custom database folder* in Settings → Storage moves the caches elsewhere. Deleting the folder
resets the plugin; the Eagle library is not affected.

## AI matching

AI matching and AI partial-clip detection use the same model as VDF, DINOv2-small (int8 ONNX, about
24 MB). It runs locally through onnxruntime. The model is not bundled: the first time you enable
AI, the plugin asks before downloading it from the VDF release on GitHub (Hugging Face as
fallback) and checks its SHA-256 before use. Settings → AI can remove it again.

## Background behaviour

Eagle keeps a closed plugin window alive for five minutes and then unloads it. During a scan, or
while a daily scheduled scan is enabled, closing the window minimises it to the taskbar instead, so
the work is not cut off. Without either, the window closes normally and the plugin uses no
resources after Eagle unloads it.

## How it differs from VDF

- It works on Eagle items and folders, not directories. Deleting means Eagle trash, which can be
  undone.
- Mirrored copies also pass VDF's group-representative check, so a flipped copy lands in its
  group. In VDF it can be split off.
- Clips can join a group their source video is already in (VDF skips sources that are already
  grouped).
- Hardware-accelerated decoding defaults to off. For single 32×32 frames it rarely saves time, and
  software decoding keeps fingerprints identical across GPUs. Settings can switch it on.

[docs/DESIGN.md](docs/DESIGN.md) has the matching rules, the architecture and the full
feature-by-feature parity table with VDF.

## Development

```
plugin/            the plugin (what gets packaged)
  js/core/         matching maths, grouping, selection, expressions (pure, unit-tested)
  js/engine/       the scan engine: separate Node process (Eagle.exe with ELECTRON_RUN_AS_NODE)
  js/ui/           the window: pages, dialogs, Eagle data access
test/              unit tests, end-to-end engine tests, synthetic fixture library
tools/             test runner, fixture generator, UI harness, packager
```

- `node tools/make-fixtures.js` builds the synthetic test library with Eagle's FFmpeg. It holds
  re-encodes, crops, flips, zooms, clips, silent clips, dark files and images.
- `node tools/run-tests.js` runs every test on Eagle's own runtime. The end-to-end tests need the
  fixtures, and the AI test also needs the model in `%TEMP%\vdf-eagle-ai`.
- `tools/ui-harness` runs the real UI in Electron 22 (Eagle's version) against a mock `eagle` API
  over the fixtures, with a local control endpoint for scripted checks
  (`npx electron@22 tools/ui-harness/main.js --eagle-url`). `--eagle-url` loads the page exactly
  as Eagle does (`eagleplugin://` scheme and Eagle's `require` override). `node
  tools/ui-harness/ctl.js key Enter` sends a real key press, for checking dialog focus.

### Building

```
node tools/setup-runtime.js   # installs onnxruntime-node into plugin/ and trims it to Windows x64
```

After that, the `plugin` folder holds only runtime files, so Eagle can pack it as it is: import
it with **Plugins → Developer options → Import local project**, then right-click the plugin in
the plugin panel and choose **Pack Plugin**. That is the package Eagle's Plugin Center expects.

`node tools/pack.js` builds the same package without Eagle, into `dist/`; it is used to check
the package in tests.

## License

GNU Affero General Public License v3.0, the same as Video Duplicate Finder, which this plugin is
derived from. See `plugin/LICENSE` and `plugin/THIRD-PARTY-NOTICES.txt`.
