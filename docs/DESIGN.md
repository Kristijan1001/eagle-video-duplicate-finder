# Design notes

How the plugin ports Video Duplicate Finder (VDF, 0x90d/videoduplicatefinder) to Eagle: the matching rules it reproduces, its architecture, and a feature-by-feature parity table with VDF.

## 1. How VDF decides "duplicate" (reproduced exactly)

This is from reading the source (`ScanEngine.cs`, `GrayBytesUtils.cs`, `PerceptualHash.cs`, `PHashCompare.cs`, `DaisyChainSplitter.cs`), not from a summary.

1. **Sample positions.** `ThumbnailCount = N` gives positions `k/(N+1)` for k = 1..N, so never the first or last frame. A position in seconds is `duration × pos`, and the duration is capped by `MaxSamplingDurationSeconds` when that is set.
2. **Gray frame per position.** This is the exact FFmpeg CLI call:
   `ffmpeg -hide_banner -loglevel error -nostdin [-hwaccel X] -ss <sec> -i <file> -vf [userVf,]scale=32:32:flags=bicubic,format=gray -f rawvideo -pix_fmt gray -frames:v 1 pipe:1`
   The output is 1024 bytes. Images are read the same way but with **no `-ss`** (VDF bug #801).
3. **Too dark.** A frame counts as dark when at least 80% of its pixels are ≤ `0x20`. If *every* newly sampled frame is dark, the file is flagged TooDark and skipped.
4. **Gray difference.** This is the mean absolute difference over all 1024 bytes, divided by 256. With "ignore black" or "ignore white" on, pixels where either frame is ≤ 0x20 (black) or ≥ 0xF0 (white) are left out of the mean. For videos the per-frame differences are summed, and the file fails once `sum > (1 − Percent/100) × N`, with an early exit. The pair is a duplicate when the mean is within that bound.
5. **pHash.** This is a DCT of the 32×32 frame. It keeps the 8×8 low-frequency block (u, v = 1..8) and thresholds each value against the median. Two hashes match when the Hamming distance is ≤ `floor((1 − Percent/100) × 64)`. A video pair must also pass at `≥ ceil(N × PHashRequiredMatchingSampleRatio)` positions (default 0.6).
6. **Modes.** Grayscale (default), pHash, or **combined**. In combined mode a pair matches if either method matches, and flags record which one did. **Images always use grayscale.**
7. **Flipped.** When enabled, the check is repeated with each frame mirrored horizontally (and its pHash recomputed). The better of the two results wins and is flagged *Flipped*.
8. **Pre-filters.** Videos are only compared with videos, and images only with images. For videos, the duration gap must be ≤ `min(tolerance(a), tolerance(b))`. Tolerance is `PercentDurationDifference %` (default 20), clamped by the Min/Max seconds settings; when the percent is 0, the seconds bound is a flat tolerance. The folder-match gate and the hard-link gate also apply here.
9. **Grouping (`MergeDuplicate`).** Pairs are merged into groups. When an item joins a group, or two groups merge, the group's *representative* must also match. This stops one bridging pair from chaining unrelated groups together.
10. **Daisy-chain split.** For every group of 3 or more, VDF builds the full pair matrix and prunes members that match fewer than a majority of the group. It then re-clusters the pruned members into their own groups and drops members that end up alone.
11. **Float semantics.** C# does all of this in `float` (32-bit). The port wraps every step in `Math.fround` so borderline pairs land on the same side of the threshold as they do in VDF. pHash uses SIMD dot products, which VDF itself says can differ by up to 2 bits in fewer than 0.01% of frames. The port is tested against the same behaviour.

---

## 2. Architecture

```
plugin/                    the Eagle plugin (what gets packed)
├─ manifest.json           window plugin, frameless, keepAlive, dependencies: ["ffmpeg"], devTools off
├─ index.html, css/, logo.png
├─ js/app.js               boot, window chrome, navigation, library switching, scan orchestration
├─ js/core/                pure logic, no DOM or Eagle API; unit-tested on Eagle's own Node runtime
│  ├─ settings.js          every VDF setting with its defaults, the scan profiles, per-library scopes
│  ├─ gray.js, phash.js    gray-frame difference (black/white masks, flip), DCT pHash
│  ├─ matcher.js           pair check: gray / pHash / combined, flipped, duration, folder, hard-link gates, AI
│  ├─ grouping.js          MergeDuplicate with representative gating, DaisyChainSplitter
│  ├─ chroma.js            VDF's Chromaprint-style audio fingerprint and sliding-window match
│  ├─ partial.js           partial-clip assignment, visual confirmation, AI keyframe offset voting
│  ├─ results.js           result rows, best-value badges, sorting, hover diffs
│  ├─ selection.js         quality ranker, identical/oldest/newest/lowest-quality, custom selection
│  ├─ expression.js        VDF's C#-style selection expressions (own parser, no eval)
│  ├─ diffmap.js           the comparer's structural difference boxes (VDF DifferenceMap)
│  └─ comparer-logic.js    winner-stays culling walk and the comparer's info chips
├─ js/engine/              runs in a separate process (below)
│  ├─ main.js              command loop over IPC
│  ├─ scan.js              the scan pipeline (probe, sample, fingerprint, compare, clips, results)
│  ├─ ff.js                FFmpeg/FFprobe calls with timeouts and stall detection
│  ├─ compare.js, compare-worker.js   parallel pair search on worker_threads over SharedArrayBuffers
│  ├─ cache.js             per-library fingerprint cache: sharded binary files, atomic writes
│  ├─ ai.js                DINOv2 model download (SHA-256 checked) and inference via onnxruntime-node
│  └─ drive.js, exif.js    SSD/HDD detection, EXIF dates
└─ js/ui/                  pages (Scan, Results, Settings, Database, Log), Compare window, dialogs
```

**Process model**
- **Plugin window.** Eagle API calls, DOM and orchestration only; it never runs a long loop.
- **Engine.** Forked with Eagle's own executable in Node mode (`ELECTRON_RUN_AS_NODE`), so the
  window stays responsive during a scan. It exits when the window goes away.
- **Comparison.** `worker_threads` inside the engine share the frame data through
  `SharedArrayBuffer`s. Pairs found in parallel are merged into groups in one deterministic
  pass, so results do not depend on thread timing.
- **FFmpeg / FFprobe.** Child processes from Eagle's FFmpeg plugin. Concurrency follows the
  drive type (VDF's rule: 2 at a time on a hard drive). A stalled process is killed.
- **Cache.** `%LOCALAPPDATA%\VDF for Eagle\libraries\<library>-<hash>\`, keyed by Eagle item
  id and checked against file size and modification time, so renames and moves never
  invalidate it. Frames are keyed by position in seconds, so changing the frame count reuses
  every frame already sampled.

---

## 3. Feature parity with VDF

Legend: **Port** = same behaviour, **Adapt** = same intent through the Eagle equivalent, **N/A** = cannot apply inside Eagle (the reason is given).

### 3.1 Scanning and matching
| VDF feature / setting | Status |
|---|---|
| Include folders / Exclude folders (Blacklists) | **Adapt.** Scope = whole library / current selection / Eagle folders (with "include subfolders") / smart folders / tags. Exclude = Eagle folders and tags. |
| IncludeSubDirectories | **Port.** Applies to Eagle folder scope (recursive `folder.children`). |
| IncludeImages / file-type handling | **Port.** Uses VDF's video and image extension lists, plus every other extension FFmpeg can decode. |
| ScanAgainstEntireDatabase | **Port.** Finds duplicates of the scoped items anywhere in the library, using cached fingerprints. |
| FolderMatchMode (Same / Different folder only) + SameFolderDepth | **Adapt.** Uses Eagle folder membership and ancestors at depth N. An item can be in several folders, so "same" means they share one. |
| Percent threshold, Threshhold | **Port.** |
| UsePHashing, CombineGrayscaleAndPHash, PHashRequiredMatchingSampleRatio | **Port.** |
| CompareHorizontallyFlipped | **Port.** |
| IgnoreBlackPixels / IgnoreWhitePixels | **Port.** |
| ThumbnailCount (sample positions), MaxSamplingDurationSeconds | **Port.** |
| PercentDurationDifference, DurationDifferenceMin/MaxSeconds | **Port**, including the "0% means flat seconds tolerance" rule. |
| TooDark detection | **Port.** |
| ExcludeHardLinks | **Port.** Compares `fs.stat` `dev`+`ino` (bigint). |
| IgnoreReparsePoints, IgnoreReadOnlyFolders | **Port.** Uses `lstat` for symlinks/junctions and a read-only attribute check on the item's file and folder. |
| File-size filter, path Contains / NotContains filters (wildcards) | **Port.** Patterns match against the Eagle item name, Eagle folder path, and file path. |
| IncludeNonExistingFiles | **Port.** Items whose file is missing still compare using cached fingerprints and are marked *missing*. |
| RememberDeletedContent (tombstones) + AutoCheckDeletedContentMatches | **Port**, and it fits Eagle well. When an item is trashed from the plugin, or leaves the library, its fingerprint is kept. A later re-import of the same content shows up as "previously deleted" and can be auto-checked. |
| Partial clip detection (audio): min ratio, audio similarity, require visual confirm, visual threshold | **Port.** VDF's own Chromaprint-style pipeline is ported line for line. PCM comes from FFmpeg (`-vn -ac 1 -ar 11025 -f s16le`). Results show a *Clip offset* column. |
| AI matching (DINOv2) + AiPercent | **Port.** Same model file and **same SHA-256** as VDF (`dinov2-small-int8.onnx`, `3afdc8bc…d917`), downloaded on first use only after a consent prompt. Same preprocessing (224×224 RGB, ImageNet mean/std, CLS token), same int8 quantization, same dark-frame guard. Runs locally only. |
| AI partial (visual) detection + AiPartialHitPercent | **Port.** Dense keyframe embeddings with time-offset voting (≥ 4 hits agreeing), kept in a sidecar cache like VDF's `DenseEmbeddings.db`. |
| Scan profiles (Exact & near / Edited & altered / AI scan / Deep clean / Custom) | **Port**, using the same knob bundles. Editing any knob switches to Custom and saves a snapshot. |
| MaxDegreeOfParallelism, HddMaxDegreeOfParallelism, MatchingMaxDegreeOfParallelism, DriveTypeOverrides | **Port / Adapt.** Every Eagle file sits on the library drive, so it's one drive probe plus an override. Read and compare concurrency are separate settings. |
| HardwareAccelerationMode | **Port.** Offers the `-hwaccel` modes this FFmpeg actually has. |
| CustomFFArguments (user `-vf` placed before scale, same as VDF) | **Port.** |
| UseNativeFfmpegBinding | **N/A.** Eagle's FFmpeg plugin ships command-line binaries, not libraries; frames come from the FFmpeg CLI exactly as in VDF's CLI path. |
| UseExifCreationDate | **Port.** EXIF DateTimeOriginal for images, `creation_time` tag for videos. It feeds the Oldest/Newest selection. |
| AlwaysRetryFailedSampling, ExtendedFFToolsLogging, LogExcludedFiles | **Port.** |
| Crash journal / quarantine | **Adapt.** A hanging FFmpeg is killed on timeout or stall. A file whose sampling failed is flagged and skipped on later scans unless *Always retry failed sampling* is on; the Database page lists and retries such files. |
| Pause / Resume / Stop, progress + ETA + heartbeat | **Port.** |
| DatabaseCheckpointIntervalMinutes | **Port.** The cache is saved every N minutes and at phase ends, so a crash loses at most N minutes of work. |
| Scheduled scan + notify on complete | **Adapt.** Uses `eagle.notification`. It's a window plugin, so a scheduled scan runs while the plugin is open or minimized; with a schedule on, closing the window minimizes it instead. |

### 3.2 Results and review
| VDF feature | Status |
|---|---|
| Grouped results list, collapse/expand, density toggle | **Port.** Virtualized, so thousands of groups scroll smoothly. |
| Columns: thumbnails, duration, format, bitrate, languages, similarity, size/date | **Port.** Plus Eagle's own fields: folders, tags, rating, and the Eagle thumbnail. |
| Sampled-frame thumbnails (GeneratePreviewThumbnails, ThumbnailMaxWidth) | **Port.** Shows the frames that were actually compared, cached as small JPEGs. |
| "Best" badges (duration, size, FPS, bitrate, audio, HDR, resolution) + tooltip showing which criterion decided | **Port.** |
| Flag chips: Flipped / Gray / pHash / AI / Partial + offset / Missing / Previously deleted | **Port.** |
| Sort modes (Wasted space, Total size, Largest file, File count, Similarity, Date…) + descending + best-first | **Port.** |
| Filter: file type (All/Videos/Images), text, flags | **Port.** |
| Hover difference (metric deltas to the best) + "Compare values with the best" | **Port.** Plus, as an addition, a large frame preview with difference boxes when hovering a sampled frame. |
| Thumbnail comparer: Single / Swipe / Side-by-side / Stacked, frame stepping per side and together, difference boxes + sensitivity, zoom/pan, keep left/right, not a match, group navigation | **Port.** Plus synced playback of both files in the built-in player (FFmpeg frames for codecs it cannot decode). |
| Metadata compare (group) | **Port.** Table view with the differences highlighted. |
| Pair diagnostic ("why are / aren't these two a match?") | **Port.** From a group's menu: per-position gray difference, pHash distance, AI similarity, and which gate passed or blocked. |
| Keyboard navigation: next/prev group, keep-highlighted-and-advance, shortcuts | **Port.** Fixed shortcuts in this release (listed in Settings). |

### 3.3 Selection tools
| VDF feature | Status |
|---|---|
| Check lowest quality (criteria order dialog: Duration, Resolution, Bitrate, FPS, Bits-per-pixel, Audio bitrate, Size smaller/larger; with near-tie rules) | **Port.** |
| Check when identical / identical-but-size / oldest / newest | **Port.** |
| Custom selection: expression builder, presets, history, auto-apply preset | **Port.** A safe expression parser; no `eval`. |
| Keep best in group, check all in group, invert, clear, undo selection | **Port.** |

### 3.4 Actions (Eagle equivalents of VDF's file operations)
| VDF action | Status |
|---|---|
| Delete checked (recycle bin) | **Adapt.** `item.moveToTrash()` into **Eagle's trash**, recoverable in Eagle. Asks for confirmation first, showing the count and size. |
| Delete permanently | **Adapt.** The Eagle API has no permanent delete. Items go to Eagle's trash and you empty it in Eagle. |
| *New:* **Merge into keeper, then trash** | Before trashing duplicates, the keeper takes over their tags and folders, the highest rating, and non-empty annotation/URL (each field can be switched on or off). No Eagle organisation work is lost. |
| Move / copy checked to folder | **Adapt.** Move to an Eagle folder (replace folders) or add to an Eagle folder (keep existing). A separate *Export copies to disk…* copies the original files to a folder on disk. |
| Rename file | **Adapt.** Renames the Eagle item (`item.name`). |
| Open / open in folder / custom open commands (CustomCommands) | **Port.** Open in Eagle (`eagle.item.open`, optionally in a new window), show in Explorer, open with the default app, or open with a custom command template such as mpv. |
| Copy paths / filenames / item details to clipboard | **Port.** |
| Remove from list, remove + exclude (blacklist), mark group "not a match" | **Port.** Persists per library. |
| Create hard links / symbolic links for checked items | **N/A, left out on purpose.** Eagle owns every file in its `.library`. Swapping those files for links behind Eagle's back would corrupt the library. *Merge into keeper, then trash* is the Eagle-safe replacement. |
| Export results JSON / CSV / "pretty" HTML, import results, cleanup dry-run report, backup after list change | **Port.** (VDF's "ask to save on exit" is not needed: results are saved automatically.) |
| Tag checked items | **New (Eagle).** |
| Select group in Eagle | **New (Eagle).** `eagle.item.select(ids)` selects the group in the main Eagle window. |

### 3.5 Database management
| VDF feature | Status |
|---|---|
| Database viewer/editor (clear cached hashes, exclude/include entries) | **Port.** |
| Cleanup DB / prune ghost entries / clear DB | **Port.** Removes cache entries for items no longer in the library, and keeps tombstones when that option is on. |
| Export / import DB as JSON | **Port.** |
| Relocate files (PathRelocator), legacy DB reader, OsHash relink | **N/A.** The cache is keyed by Eagle item id, so moving the library or renaming files never breaks it. VDF needs these tools only because it keys by path. |

### 3.6 App and frontend features
| VDF feature | Status |
|---|---|
| GUI / CLI / Web UI / Docker | **N/A.** The Eagle plugin is the frontend. |
| FFmpeg downloader | **Adapt.** The Eagle FFmpeg dependency plugin replaces it (the install prompt comes up automatically if it is missing). |
| AI components downloader | **Port.** Consent prompt, progress, SHA-256 check. |
| Theme (System/Light/Dark), Mica, UI scale, high contrast, reduce motion | **Adapt.** Follows Eagle's theme live (`onThemeChanged`). UI scale setting, `prefers-reduced-motion`, ARIA labels, keyboard focus. Mica is N/A. |
| Language selection (LanguageService) | **Not in this release.** English only. |
| Log view | **Port.** A plugin log page; errors are also written to Eagle's log. |
| Welcome strip / results hint / setup notices, announcements | **Port** the onboarding hints. Announcements are **N/A** (they come from the upstream server). |

---

## 4. Eagle integration
- The plugin opens from Eagle's plugin panel. It uses a frameless window with Eagle-style chrome, follows Eagle's theme, and reloads when the library switches.
- **Scan what's selected.** The *Selected items* scope scans whatever is selected in Eagle when the scan starts, and *Use folders selected in Eagle* fills the folder picker.
- The UI shows Eagle thumbnails right away (`thumbnailURL`), so results look like Eagle before any frame is extracted.
- Every result links back into Eagle: select in Eagle, open in Eagle, reveal in its folder.
- All changes go through `item.save()` / `moveToTrash()` only. `metadata.json` is never touched (Eagle's own best-practice rule). Every destructive step shows a confirm dialog and writes an undo record: the trash list plus the metadata before a merge.
- It depends on the official FFmpeg plugin (`"dependencies": ["ffmpeg"]`). If FFmpeg is missing, the plugin offers the install prompt.

---

## 5. Safety rules
- It never deletes files itself. The only removal path is Eagle's own trash.
- The trash confirmation shows the item count and total size. A dry-run report is available first.
- Batch changes (trash, move or add to folder, tag) confirm first and change exactly the items the
  confirmation lists. Moving shows each item's current folders next to the destination, since it
  replaces them. Focus starts on Cancel, so Enter never confirms; "Don't ask again" turns one
  confirmation off (Settings → Confirmations), except trashing every copy of a group, which
  always asks.
- A merge writes a JSON undo record (the keeper's metadata before the merge plus the trashed ids), and *Undo last action* restores the keeper and pulls the items back out of Eagle's trash.
- The scan is read-only toward the library. The cache lives outside the `.library`.

---

