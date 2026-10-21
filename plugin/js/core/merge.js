'use strict';
// What "merge into the copy that stays" changes on that copy. The trash confirmation shows this
// plan and eagle-data applies the same plan, so the preview and the result cannot drift apart.

const MAX_ANNOTATION = 10000; // item.save limit in Eagle 4 (MAX_STRING_LENGTH)

const unique = (a) => [...new Set(a)];

/**
 * keeper, others: { tags, folders, star, annotation, url }.
 * opts: { mergeTags, mergeFolders, mergeRating, mergeAnnotation, mergeUrl }.
 * Returns {
 *   next: the keeper's values after the merge,
 *   addTags, addFolders: what the keeper gains,
 *   star: { from, to } | null, url: the source URL it takes | null,
 *   notesAdded: other copies' notes joined in, notesSkipped: notes that did not fit Eagle's limit,
 *   changed: whether anything differs from the keeper's current values,
 * }
 */
function planMerge(keeper, others, opts) {
	const cur = {
		tags: [...(keeper.tags || [])], folders: [...(keeper.folders || [])], star: keeper.star || 0,
		annotation: keeper.annotation || '', url: keeper.url || '',
	};
	const next = { ...cur, tags: [...cur.tags], folders: [...cur.folders] };
	const plan = { next, addTags: [], addFolders: [], star: null, url: null, notesAdded: 0, notesSkipped: 0, changed: false };
	if (opts.mergeTags) {
		next.tags = unique([...cur.tags, ...others.flatMap((o) => o.tags || [])]);
		plan.addTags = next.tags.filter((t) => !cur.tags.includes(t));
	}
	if (opts.mergeFolders) {
		next.folders = unique([...cur.folders, ...others.flatMap((o) => o.folders || [])]);
		plan.addFolders = next.folders.filter((f) => !cur.folders.includes(f));
	}
	if (opts.mergeRating) {
		const best = Math.max(cur.star, ...others.map((o) => o.star || 0));
		if (best !== cur.star) { next.star = best; plan.star = { from: cur.star, to: best }; }
	}
	if (opts.mergeAnnotation) {
		const own = cur.annotation.trim();
		const notes = unique([own, ...others.map((o) => (o.annotation || '').trim())].filter(Boolean));
		// Eagle rejects notes over its limit: keep whole notes that fit
		let joined = '';
		let kept = 0;
		for (const n of notes) {
			const t = joined ? `${joined}\n\n${n}` : n;
			if (t.length > MAX_ANNOTATION) break;
			joined = t;
			kept++;
		}
		plan.notesSkipped = notes.length - kept;
		plan.notesAdded = Math.max(0, kept - (own ? 1 : 0));
		if (joined !== cur.annotation) next.annotation = joined;
	}
	if (opts.mergeUrl && !cur.url) {
		const u = others.map((o) => o.url).find(Boolean);
		if (u) { next.url = u; plan.url = u; }
	}
	plan.changed = plan.addTags.length > 0 || plan.addFolders.length > 0 || !!plan.star || !!plan.url || next.annotation !== cur.annotation;
	return plan;
}

module.exports = { planMerge, MAX_ANNOTATION };
