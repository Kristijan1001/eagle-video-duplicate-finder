# Video Duplicate Finder: notes for reviewers

Finds duplicate and near-duplicate videos and images in an Eagle library and helps clean them
up. The matching is a port of Video Duplicate Finder by 0x90d
(https://github.com/0x90d/videoduplicatefinder, AGPL-3.0). This plugin is AGPL-3.0 as well,
and its full source is the JavaScript in this package. Source repository:
https://github.com/Kristijan1001/eagle-video-duplicate-finder

## Requirements

- Eagle 4 on Windows x64 (the only platform this release is built and tested for).
- Eagle's official FFmpeg plugin (declared in `manifest.json` under `dependencies`). If it is
  missing, the plugin asks and installs it through Eagle.
- No account, key or external service is needed for the core workflow.

## How to test the main workflow

1. Open a library that contains a few videos or images that are copies of each other. A
   re-encoded or resized copy of any video works.
2. Open the plugin. On **Scan**, keep **Whole library** (or pick **Folders** and tick a folder),
   keep the default **Edited & altered** profile and press **Start scan**. The first scan reads
   every file once; later scans reuse the cache.
3. **Results** lists the duplicate groups. Tick copies to remove (or use **Select → Lowest
   quality copies…**), then **Trash checked**. Items go to Eagle's trash and **Undo** restores
   them.
4. **Compare** (the compare button on a group) shows two files side by side, plays them in
   sync and steps them frame by frame.

Nothing in the library changes until the user runs an action in Results. Trashing always
shows a confirmation with the number and size of the items. Tagging, moving and renaming start
from a dialog where the user enters the tag, folder or name.

## What the plugin changes in Eagle (only on user action)

- **Trash:** sets the item's `isDeleted` flag through the Eagle API, so items land in Eagle's
  trash. It never deletes files. Undo restores them.
- **Optional merge before trashing:** copies tags, folders, rating, annotation and source URL
  from the trashed copies onto the kept one. Undo reverts it.
- Also on request: add a tag, add to or move to a folder, rename an item, and export copies of
  files to a folder the user picks. Folder moves, tags and renames can be undone.

## Data it writes outside Eagle

- `%LOCALAPPDATA%\VDF for Eagle\`: settings, a per-library fingerprint cache, the last
  results, and the optional AI model. Deleting this folder resets the plugin. Nothing is
  written into the Eagle library folder.
- `%TEMP%\vdf-for-eagle\`: short-lived frame images while scanning.
- Exports (JSON/CSV/HTML reports, copied files) go only to paths the user chooses.

## Network access

There is none by default. The only connection is the **optional AI model download**
(DINOv2-small, about 24 MB). It happens only after the user enables AI matching and agrees in a
dialog. It comes from the VDF GitHub release
(`github.com/0x90d/videoduplicatefinder/releases/download/ai-models-v1/…`), with Hugging Face
(`huggingface.co/Xenova/dinov2-small`) as a fallback, and is verified by SHA-256 before use. The
model runs locally through the bundled onnxruntime-node (Microsoft, MIT).

No library data, file names or file contents are sent anywhere. There is no analytics or
telemetry.

## Processes it starts

- **The scan engine:** Eagle's own executable in Node mode (`ELECTRON_RUN_AS_NODE`), running
  `js/engine/main.js`, so the window stays responsive. It exits when the plugin window closes.
- **FFmpeg / FFprobe** from Eagle's FFmpeg plugin, to read frames, audio and metadata.
  Read-only.
- **`powershell.exe`**, once per scan: `Get-Partition` / `Get-PhysicalDisk` for the library's
  drive letter, to see whether it is an SSD or HDD (this sets how many files are read at
  once). Read-only.
- **Custom commands** (Settings → Custom commands) are empty by default. They run only if the
  user enters a command and picks "Open with custom command".

## Background behaviour

With `keepAlive`, Eagle keeps a closed plugin window for 5 minutes. During a scan, or while the
optional daily scheduled scan is enabled, closing the window minimises it to the taskbar
instead, so the work is not cut off. Otherwise nothing keeps running.

## Uninstalling

Removing the plugin leaves `%LOCALAPPDATA%\VDF for Eagle\` (cache and settings) in place. Delete
that folder to remove everything. The Eagle library itself is never touched by uninstalling.
