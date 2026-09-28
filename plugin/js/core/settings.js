'use strict';
// Every VDF setting (VDF.Core/Settings.cs + VDF.GUI/Data/SettingsFile.cs) with VDF's GUI
// defaults, plus the Eagle-specific scope options that replace VDF's include/exclude
// directory lists. Keys keep VDF's names in camelCase so the mapping stays obvious.

const DEFAULTS = Object.freeze({
	// ── Scope (Eagle replaces VDF's Includes / Blacklists directory lists) ──
	scopeMode: 'library',            // library | selection | folders | smartFolders | tags
	scopeFolderIds: [],
	scopeSmartFolderIds: [],
	scopeTags: [],
	scopeTagsMatchAll: false,
	includeSubDirectories: true,     // IncludeSubDirectories (Eagle subfolders)
	excludeFolderIds: [],            // Blacklists
	excludeTags: [],
	scopeLibraryKey: '',             // library the scope keys above belong to
	libraryScopes: {},               // libraryKey → saved scope keys of the other libraries
	includeImages: true,             // IncludeImages
	includeVideos: true,
	includeOtherFormatsViaThumbnail: false, // Eagle extra: compare non-media items by their Eagle thumbnail
	scanAgainstEntireDatabase: false,       // ScanAgainstEntireDatabase (= entire library cache)
	folderMatchMode: 'none',         // none | same | different  (FolderMatchMode)
	sameFolderDepth: 1,              // SameFolderDepth

	// ── Matching ──
	percent: 92,                     // Percent
	usePHash: false,                 // UsePHash
	combineGrayPHash: false,         // CombineGrayPHash
	pHashSampleRatioPercent: 60,     // PHashSampleRatioPercent
	compareHorizontallyFlipped: true,
	ignoreBlackPixels: true,
	ignoreWhitePixels: true,
	thumbnails: 1,                   // Thumbnails (sample positions per video)
	maxSamplingDurationSeconds: 0,
	percentDurationDifference: 20,
	durationDifferenceMinSeconds: 0,
	durationDifferenceMaxSeconds: 0,
	useExifCreationDate: false,

	// ── Filters ──
	excludeHardLinks: false,
	ignoreReparsePoints: false,
	ignoreReadOnlyFolders: false,
	filterByFileSize: false,
	minimumFileSize: 0,              // MB
	maximumFileSize: 999999999,      // MB
	filterByFilePathContains: false,
	filePathContainsTexts: [],
	filterByFilePathNotContains: false,
	filePathNotContainsTexts: [],
	includeNonExistingFiles: false,
	rememberDeletedContent: false,
	autoCheckDeletedContentMatches: false,

	// ── Partial clip detection (audio) ──
	enablePartialClipDetection: false,
	partialClipMinRatioPercent: 10,
	partialClipSimilarityThresholdPercent: 80,
	partialClipRequireVisualMatch: true,
	partialClipVisualThresholdPercent: 85,

	// ── AI matching ──
	useAiMatching: false,
	aiPercent: 94,
	enableAiPartialDetection: false,
	aiPartialHitPercent: 89,

	// ── Performance / FFmpeg ──
	maxDegreeOfParallelism: -1,      // -1 = automatic (processor count), 1 = strictly one file at a time
	hddMaxDegreeOfParallelism: 2,
	matchingMaxDegreeOfParallelism: 0, // 0 = automatic
	driveTypeOverride: 'auto',       // auto | ssd | hdd (all Eagle files live on the library drive)
	hardwareAccelerationMode: 'none',
	customFFArguments: '',
	alwaysRetryFailedSampling: false,
	extendedFFToolsLogging: false,
	logExcludedFiles: false,
	generatePreviewThumbnails: true,
	thumbnailMaxWidth: 160,

	// ── Database / cache ──
	customDatabaseFolder: '',
	databaseCheckpointIntervalMinutes: 5,

	// ── Results ──
	qualityCriteriaOrder: ['Duration', 'Resolution', 'Bitrate', 'FPS', 'Bits per pixel', 'Audio Bitrate', 'Size', 'SizeLarger'],
	qualityCriteriaDisabled: ['SizeLarger'],
	resultsSortMode: 'WastedSpace',
	resultsSortDescending: true,
	resultsBestFirst: false,
	resultsShowDateModified: false,
	resultsCompactRows: false,
	resultsPreviewWidth: 160,
	showThumbnailColumn: true,
	showDurationColumn: true,
	showFormatColumn: true,
	showBitrateColumn: true,
	showLanguagesColumn: false,
	showSimilarityColumn: true,
	showSizeDateColumn: true,
	showEagleColumn: true,
	thumbnailDoubleClickAction: 'OpenFile', // OpenFile | OpenThumbnailComparer
	thumbnailComparerMode: 'SideBySide',    // Single | Swipe | SideBySide | Stacked
	thumbnailComparerDiffSensitivity: 0.5,
	thumbnailComparerHighlightDifferences: false,
	backupAfterListChanged: true,
	askToSaveResultsOnExit: true,

	// ── Selection ──
	lastCustomSelectExpression: '',
	expressionHistory: [],
	expressionPresets: [],
	customSelectionPresets: [],
	autoApplySelectionPresetEnabled: false,
	autoApplySelectionPreset: '',

	// ── Eagle actions ──
	mergeTags: true,
	mergeFolders: true,
	mergeRating: true,
	mergeAnnotation: true,
	mergeUrl: true,
	duplicateTag: 'Duplicate',

	// ── Misc ──
	customCommands: { openItem: '', openMultiple: '', openItemInFolder: '', openMultipleInFolder: '' },
	keyboardShortcuts: {},
	enableScheduledScan: false,
	scheduledScanTime: '02:00',
	notifyOnScheduledScanComplete: true,
	notifyOnScanComplete: true,
	uiScalePercent: 100,
	alwaysReduceMotion: false,
	alwaysHighContrast: false,
	welcomeStripDismissed: false,
	resultsHintDismissed: false,
	customScanKnobs: null,
});

// Scan profiles (VDF.GUI/Data/ScanProfiles.cs): named bundles of the knobs they manage.
const PROFILE_KNOBS = ['percent', 'compareHorizontallyFlipped', 'ignoreBlackPixels', 'ignoreWhitePixels',
	'enablePartialClipDetection', 'useAiMatching', 'enableAiPartialDetection'];

const PROFILES = Object.freeze({
	ExactAndNear: { percent: 98, compareHorizontallyFlipped: false, ignoreBlackPixels: false, ignoreWhitePixels: false, enablePartialClipDetection: false, useAiMatching: false, enableAiPartialDetection: false },
	EditedAndAltered: { percent: 92, compareHorizontallyFlipped: true, ignoreBlackPixels: true, ignoreWhitePixels: true, enablePartialClipDetection: false, useAiMatching: false, enableAiPartialDetection: false },
	AiScan: { percent: 92, compareHorizontallyFlipped: true, ignoreBlackPixels: true, ignoreWhitePixels: true, enablePartialClipDetection: false, useAiMatching: true, enableAiPartialDetection: true },
	DeepClean: { percent: 92, compareHorizontallyFlipped: true, ignoreBlackPixels: true, ignoreWhitePixels: true, enablePartialClipDetection: true, useAiMatching: true, enableAiPartialDetection: true },
});

function knobsOf(s) {
	const k = {};
	for (const key of PROFILE_KNOBS) k[key] = s[key];
	return k;
}

/** The profile the current knob values match, or 'Custom'. */
function activeProfile(s) {
	for (const [name, knobs] of Object.entries(PROFILES)) {
		if (PROFILE_KNOBS.every((key) => s[key] === knobs[key])) return name;
	}
	return 'Custom';
}

/** Apply a profile; leaving a Custom state snapshots it so "Custom" can restore it later. */
function applyProfile(s, name) {
	const out = { ...s };
	if (name === 'Custom') {
		if (s.customScanKnobs) Object.assign(out, s.customScanKnobs);
		return out;
	}
	if (activeProfile(s) === 'Custom') out.customScanKnobs = knobsOf(s);
	Object.assign(out, PROFILES[name]);
	return out;
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/** Merge saved settings over defaults, dropping unknown keys and coercing types. */
// Folder ids, smart folder ids and tags only mean something inside one Eagle library, so
// these keys are swapped per library (see scopeForLibrary) while every other setting is global.
const LIBRARY_SCOPED_KEYS = Object.freeze(['scopeMode', 'scopeFolderIds', 'scopeSmartFolderIds', 'scopeTags', 'scopeTagsMatchAll', 'excludeFolderIds', 'excludeTags']);

/**
 * Settings patch that moves the scope keys over to `key`'s library: the current values are
 * parked under their own library and the target library's saved ones (or defaults) restored.
 * Returns null when the scope already belongs to that library.
 */
function scopeForLibrary(s, key) {
	if (s.scopeLibraryKey === key) return null;
	const pick = (src) => Object.fromEntries(LIBRARY_SCOPED_KEYS.map((k) => [k, clone(src[k])]));
	if (!s.scopeLibraryKey) return { scopeLibraryKey: key }; // first run: the current scope is this library's
	const scopes = { ...(s.libraryScopes || {}) };
	scopes[s.scopeLibraryKey] = pick(s);
	const restored = scopes[key] ? { ...pick(DEFAULTS), ...scopes[key] } : pick(DEFAULTS);
	delete scopes[key];
	return { ...restored, libraryScopes: scopes, scopeLibraryKey: key };
}

function normalize(saved) {
	const out = clone(DEFAULTS);
	if (saved && typeof saved === 'object') {
		for (const key of Object.keys(DEFAULTS)) {
			if (!(key in saved)) continue;
			const def = DEFAULTS[key];
			const v = saved[key];
			if (def === null) out[key] = v;
			else if (Array.isArray(def)) { if (Array.isArray(v)) out[key] = v; }
			else if (typeof def === 'object') { if (v && typeof v === 'object') out[key] = { ...def, ...v }; }
			else if (typeof def === typeof v) out[key] = v;
		}
	}
	out.thumbnails = clampInt(out.thumbnails, 1, 64);
	out.percent = clampNum(out.percent, 0, 100);
	out.sameFolderDepth = clampInt(out.sameFolderDepth, 1, 64);
	out.pHashSampleRatioPercent = clampNum(out.pHashSampleRatioPercent, 1, 100);
	out.aiPercent = clampNum(out.aiPercent, 50, 100);
	out.aiPartialHitPercent = clampNum(out.aiPartialHitPercent, 70, 99);
	return out;
}

function clampInt(v, lo, hi) { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }
function clampNum(v, lo, hi) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }

/**
 * Settings.GetDurationToleranceSeconds: allowed duration gap for a video of the given
 * length. Percent rule clamped by the min/max seconds; with percent 0 the larger enabled
 * seconds bound acts as a flat tolerance.
 */
function durationToleranceSeconds(s, durationSeconds) {
	if (s.percentDurationDifference > 0) {
		let t = durationSeconds * s.percentDurationDifference / 100;
		if (s.durationDifferenceMinSeconds > 0) t = Math.max(t, s.durationDifferenceMinSeconds);
		if (s.durationDifferenceMaxSeconds > 0) t = Math.min(t, s.durationDifferenceMaxSeconds);
		return Math.max(0, t);
	}
	return Math.max(0, Math.max(s.durationDifferenceMinSeconds, s.durationDifferenceMaxSeconds));
}

/** Settings the engine needs (a stable subset, so cache keys don't churn on UI-only changes). */
function engineView(s) {
	return {
		percent: s.percent,
		usePHash: s.usePHash,
		combineGrayPHash: s.combineGrayPHash,
		pHashSampleRatio: s.pHashSampleRatioPercent / 100,
		compareHorizontallyFlipped: s.compareHorizontallyFlipped,
		ignoreBlackPixels: s.ignoreBlackPixels,
		ignoreWhitePixels: s.ignoreWhitePixels,
		thumbnails: s.thumbnails,
		maxSamplingDurationSeconds: s.maxSamplingDurationSeconds,
		percentDurationDifference: s.percentDurationDifference,
		durationDifferenceMinSeconds: s.durationDifferenceMinSeconds,
		durationDifferenceMaxSeconds: s.durationDifferenceMaxSeconds,
		folderMatchMode: s.folderMatchMode,
		sameFolderDepth: s.sameFolderDepth,
		excludeHardLinks: s.excludeHardLinks,
		useAiMatching: s.useAiMatching,
		aiPercent: s.aiPercent,
		enableAiPartialDetection: s.enableAiPartialDetection,
		aiPartialHitPercent: s.aiPartialHitPercent,
		enablePartialClipDetection: s.enablePartialClipDetection,
		partialClipMinRatio: s.partialClipMinRatioPercent / 100,
		partialClipSimilarityThreshold: s.partialClipSimilarityThresholdPercent / 100,
		partialClipRequireVisualMatch: s.partialClipRequireVisualMatch,
		partialClipVisualThreshold: s.partialClipVisualThresholdPercent / 100,
		includeImages: s.includeImages,
		includeVideos: s.includeVideos,
		includeNonExistingFiles: s.includeNonExistingFiles,
		rememberDeletedContent: s.rememberDeletedContent,
		alwaysRetryFailedSampling: s.alwaysRetryFailedSampling,
		useExifCreationDate: s.useExifCreationDate,
		hardwareAccelerationMode: s.hardwareAccelerationMode,
		customFFArguments: s.customFFArguments,
		extendedFFToolsLogging: s.extendedFFToolsLogging,
		logExcludedFiles: s.logExcludedFiles,
		maxDegreeOfParallelism: s.maxDegreeOfParallelism,
		hddMaxDegreeOfParallelism: s.hddMaxDegreeOfParallelism,
		matchingMaxDegreeOfParallelism: s.matchingMaxDegreeOfParallelism,
		driveTypeOverride: s.driveTypeOverride,
		databaseCheckpointIntervalMinutes: s.databaseCheckpointIntervalMinutes,
		generatePreviewThumbnails: s.generatePreviewThumbnails,
		thumbnailMaxWidth: s.thumbnailMaxWidth,
	};
}

module.exports = {
	DEFAULTS,
	LIBRARY_SCOPED_KEYS,
	scopeForLibrary,
	PROFILES,
	PROFILE_KNOBS,
	activeProfile,
	applyProfile,
	normalize,
	durationToleranceSeconds,
	engineView,
};
