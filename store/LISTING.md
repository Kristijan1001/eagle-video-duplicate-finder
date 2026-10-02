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
- Trashing, moving, adding to a folder and tagging ask first. The confirmation shows how many
  items change and lists them, and Cancel is selected, so pressing Enter never confirms.
  "Don't ask again" turns a confirmation off; Settings → Confirmations turns it back on.
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

1.0.1
- Moving checked items to a folder now says first that their current folders will be
  replaced, shows how many items and which folder, and asks for a separate confirmation.
  Double-clicking a folder in the picker only selects it.
- Confirmations start with Cancel selected, so Enter never confirms. Keyboard focus stays
  inside an open dialog.
- Adding to a folder and tagging now also ask first. Each confirmation has "Don't ask again",
  and Settings → Confirmations turns them back on. Trashing every copy of a group always asks.
- A group's "Merge into best copy" now trashes only that group's other copies.

1.0.0
- Initial release.

## Support contact

https://github.com/Kristijan1001/eagle-video-duplicate-finder/issues

## Notes for the reviewer

No account, key or special setup is needed. A library with a few copies of the same video
(for example a re-encoded or resized copy) shows the main workflow. `README.md` in the plugin
folder lists every external connection, helper process and file change.

Changes in 1.0.1 for the previous review:
- Move checked to folder: the picker states how many items will be moved and that their
  current folders are replaced. Choosing a folder only selects it; double-click no longer runs
  the move. A separate confirmation then shows the count, the destination path and each item's
  current folders next to the new one. Exactly the listed items are changed.
- Trash checked and every other confirmation now start with focus on Cancel, so Enter cancels.
  Focus moves into the dialog when it opens and stays inside it.
- Add to folder and tagging now ask first as well. A group's "Merge into best copy" trashes
  only that group's other copies (before, it trashed everything checked).

About "Don't ask again": each of these confirmations has an unticked "Don't ask again" box. If
the user ticks it and confirms, only that confirmation is turned off. All of them are listed
under Settings → Confirmations, where they are on by default and can be switched back on.
Removing every copy of a group always asks and never offers "Don't ask again". If this option
is an issue for the review, it can be removed.
