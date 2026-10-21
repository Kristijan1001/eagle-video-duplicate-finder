# Eagle Plugin Center listing

Text to paste into the submission form. Images in this folder: `icon-512.png` / `icon-256.png`
(plugin icon), `cover-1-results.png`, `cover-2-compare.png`, `cover-3-scan.png` (1600×1000
covers, taken from a synthetic test library).

## Name

Video Duplicate Finder

## Short description

Finds duplicate and near-duplicate videos and images in your Eagle library, including
re-encodes, resized or cropped copies, mirrored copies and clips, and helps you review and
remove them.

## Introduction

Video Duplicate Finder compares the videos and images in your Eagle library and groups the
ones that are copies of each other. It finds re-encoded and resized copies, crops and
watermarked versions, mirrored copies and, optionally, clips cut out of longer videos. It is
based on the open-source Video Duplicate Finder by 0x90d.

**How to use it**
1. Open the plugin. On the **Scan** page, choose what to compare: the whole library, the items
   selected in Eagle, folders, smart folders or tags.
2. Pick a profile (**Edited & altered** is the default) and press **Start scan**. The first scan
   reads every file once, which takes a while on a hard drive; later scans only read new or
   changed files.
3. On **Results**, review the groups. Tick the copies to remove yourself, or let **Select**
   tick them, for example the lowest-quality copies. **Compare** shows two files side by side,
   plays them in sync and marks the regions where they differ.
4. **Trash checked** moves the ticked items to Eagle's trash.

**What it changes**
- Nothing in your library changes until you run an action in Results.
- **Trash checked** moves items to Eagle's trash after a confirmation. They are not deleted
  and can be restored with **Undo** or from Eagle's trash. Optionally, the copy you keep first
  takes over the tags, folders, rating, notes and source URL of the trashed copies.
- **Move checked to folder** replaces each item's folders with the one you choose (the files
  are not moved on disk). **Add to folder** and **tagging** keep existing folders and tags.
- Trashing, merging, moving, adding to a folder and tagging always ask first. The confirmation
  shows how many items change and lists them; before a merge it also shows what the copy you
  keep takes over. Cancel is selected, so pressing Enter never confirms.
- Other actions (rename, export copies of files) run only when you choose them.

**Requirements and limitations**
- Windows x64 only in this version.
- Needs Eagle's official FFmpeg plugin. The plugin offers to install it if it is missing.
- Scans run on your computer and keep a cache in `%LOCALAPPDATA%\VDF for Eagle`. Nothing is
  written into your Eagle library folder.

**Optional AI matching and network use**
AI matching finds heavily edited copies. It needs a model file (about 24 MB) that is not
included. The plugin asks before downloading it from GitHub (Hugging Face as a fallback) and
checks it before use. This is the only network access. No library data, file names or file
contents are sent anywhere.

Source code (AGPL-3.0) and support: https://github.com/Kristijan1001/eagle-video-duplicate-finder

## Changelog

The store's changelog field takes only the current version's entry (1.0.2 below).

1.0.2
- Trashing (Trash checked, the Delete key, Merge into best copy) always asks first. The
  confirmation lists the items, the copy that stays in each group and, when merging, exactly
  what that copy takes over: tags, folders, rating, notes and source URL.
- Moving checked items to a folder says first that their current folders will be replaced,
  shows how many items and which folder, and asks for a separate confirmation. Adding to a
  folder and tagging ask first too. Confirmations start with Cancel selected, so Enter never
  confirms.
- Importing a fingerprint database or a results file accepts only valid Eagle item ids, so
  imported data can never reach files outside the plugin's cache folder.
- A group's "Merge into best copy" trashes only that group's other copies.

1.0.1 (GitHub only)
- Moving checked items to a folder now says first that their current folders will be
  replaced, shows how many items and which folder, and asks for a separate confirmation.
  Double-clicking a folder in the picker only selects it.
- Confirmations start with Cancel selected, so Enter never confirms. Keyboard focus stays
  inside an open dialog.
- Adding to a folder and tagging now also ask first. Each confirmation has "Don't ask again",
  and Settings → Confirmations turns them back on (both removed again in 1.0.2). Trashing every
  copy of a group always asks.
- A group's "Merge into best copy" now trashes only that group's other copies.

1.0.0
- Initial release.

## Support contact

https://github.com/Kristijan1001/eagle-video-duplicate-finder/issues

## Notes for the reviewer

No account, key or special setup is needed. A library with a few copies of the same video
(for example a re-encoded or resized copy) shows the main workflow. `README.md` in the plugin
folder lists every external connection, helper process and file change.

Changes in 1.0.2 for the previous review:
- Imported ids: `importJson()` (js/engine/cache.js) now validates every record: the id must be
  an Eagle item id (letters and digits only, js/core/ids.js) and every field must have the
  exported shape; anything else is skipped. All cache files named after an id (dense
  `<id>.bin`, thumbnails, compare frames) are built through `fileFor()`, which returns no path
  for an invalid id and checks that the resolved file is a direct child of its cache folder.
  `delete()`, `clearDerived()`, `readDense()` and `writeDense()` therefore cannot reach outside
  the cache, and entries with an invalid id already in a cache are dropped when it loads.
  "Import results" likewise keeps only items with a valid id, name and extension. Unit tests
  (test/unit/ids.test.js in the source repository) import records with ids such as `../x`,
  `..\x`, `C:\x` and `/x` and check that files outside the cache survive cleanup, clear entry
  and delete entry.
- "Don't ask again" and the Confirmations settings are removed. Trash checked, the Delete key,
  Merge then trash and a group's Merge into best copy always open the confirmation, with Cancel
  focused. It shows the affected items and their count, the copy that stays in each group and,
  when merging, exactly what that copy takes over (tags and folders gained, rating change,
  notes added, source URL). The merge applies the same plan (js/core/merge.js). Settings saved
  by 1.0.1 that turned confirmations off are ignored.
- Move, add to folder and tagging also always confirm, as in 1.0.1.
