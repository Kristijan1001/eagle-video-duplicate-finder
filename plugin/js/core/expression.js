'use strict';
// Selection expressions — the Eagle counterpart of VDF's Expression Builder (DynamicExpresso,
// C# syntax over DuplicateItem). Same style, e.g.
//
//   item.IsImage && item.SizeLong > 3000
//   item.Path.Contains("imageFolder")
//   item.Duration.Minutes > 15
//   Regex.IsMatch(item.Name, "S\\d+E\\d+")
//   item.Tags.Contains("wip") || item.Rating < 2
//
// Parsed into an AST and interpreted — nothing is ever evaluated as code, and assignment
// does not exist in the grammar (VDF disables it for the same reason).

class ExprError extends Error {}

// ── tokenizer ──
const PUNCT = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')', ',', '.', '+', '-', '*', '/', '%', '?', ':', '[', ']'];

function tokenize(src) {
	if (/(^|[^=!<>])=([^=]|$)/.test(src.replace(/@?"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')))
		throw new ExprError('Assignment is not allowed (did you mean ==?)');
	const t = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) { i++; continue; }
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
			const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdDmMlL]?/.exec(src.slice(i));
			t.push({ k: 'num', v: parseFloat(m[0].replace(/[fFdDmMlL]$/, '')) });
			i += m[0].length;
			continue;
		}
		if (c === '"' || c === '\'' || (c === '@' && src[i + 1] === '"')) {
			const verbatim = c === '@';
			const q = verbatim ? '"' : c;
			let j = i + (verbatim ? 2 : 1), s = '';
			for (; j < src.length; j++) {
				if (verbatim && src[j] === '"' && src[j + 1] === '"') { s += '"'; j++; continue; }
				if (!verbatim && src[j] === '\\') {
					const n = src[++j];
					s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '0' ? '\0' : n;
					continue;
				}
				if (src[j] === q) break;
				s += src[j];
			}
			if (j >= src.length) throw new ExprError('Unterminated string');
			t.push({ k: 'str', v: s });
			i = j + 1;
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
			t.push({ k: 'id', v: m[0] });
			i += m[0].length;
			continue;
		}
		const p = PUNCT.find((x) => src.startsWith(x, i));
		if (!p) throw new ExprError(`Unexpected character '${c}' at ${i + 1}`);
		t.push({ k: 'p', v: p });
		i += p.length;
	}
	t.push({ k: 'end' });
	return t;
}

// ── parser (precedence climbing) ──
function parse(src) {
	const toks = tokenize(src);
	let pos = 0;
	const peek = () => toks[pos];
	const eat = (v) => { if (peek().v === v) { pos++; return true; } return false; };
	const expect = (v) => { if (!eat(v)) throw new ExprError(`Expected '${v}'`); };

	function ternary() {
		const cond = or();
		if (eat('?')) { const a = ternary(); expect(':'); const b = ternary(); return { t: 'cond', cond, a, b }; }
		return cond;
	}
	function or() { let l = and(); while (eat('||')) l = { t: 'or', l, r: and() }; return l; }
	function and() { let l = eq(); while (eat('&&')) l = { t: 'and', l, r: eq() }; return l; }
	function eq() {
		let l = rel();
		for (;;) {
			if (eat('==')) l = { t: 'bin', op: '==', l, r: rel() };
			else if (eat('!=')) l = { t: 'bin', op: '!=', l, r: rel() };
			else return l;
		}
	}
	function rel() {
		let l = add();
		for (;;) {
			const op = ['<=', '>=', '<', '>'].find((o) => peek().v === o && peek().k === 'p');
			if (!op) return l;
			pos++;
			l = { t: 'bin', op, l, r: add() };
		}
	}
	function add() {
		let l = mul();
		for (;;) {
			if (peek().k === 'p' && (peek().v === '+' || peek().v === '-')) { const op = toks[pos++].v; l = { t: 'bin', op, l, r: mul() }; }
			else return l;
		}
	}
	function mul() {
		let l = unary();
		for (;;) {
			if (peek().k === 'p' && ['*', '/', '%'].includes(peek().v)) { const op = toks[pos++].v; l = { t: 'bin', op, l, r: unary() }; }
			else return l;
		}
	}
	function unary() {
		if (eat('!')) return { t: 'not', e: unary() };
		if (eat('-')) return { t: 'neg', e: unary() };
		return postfix(primary());
	}
	function args() {
		const a = [];
		if (eat(')')) return a;
		do a.push(ternary()); while (eat(','));
		expect(')');
		return a;
	}
	function postfix(e) {
		for (;;) {
			if (eat('.')) {
				const id = toks[pos++];
				if (id.k !== 'id') throw new ExprError('Expected a member name after "."');
				if (eat('(')) e = { t: 'call', obj: e, name: id.v, args: args() };
				else e = { t: 'member', obj: e, name: id.v };
			}
			else if (eat('[')) { const i = ternary(); expect(']'); e = { t: 'index', obj: e, i }; }
			else return e;
		}
	}
	function primary() {
		const tk = toks[pos++];
		if (tk.k === 'num') return { t: 'lit', v: tk.v };
		if (tk.k === 'str') return { t: 'lit', v: tk.v };
		if (tk.k === 'p' && tk.v === '(') { const e = ternary(); expect(')'); return e; }
		if (tk.k === 'id') {
			if (tk.v === 'true') return { t: 'lit', v: true };
			if (tk.v === 'false') return { t: 'lit', v: false };
			if (tk.v === 'null') return { t: 'lit', v: null };
			return { t: 'name', v: tk.v };
		}
		throw new ExprError(tk.k === 'end' ? 'Unexpected end of expression' : `Unexpected '${tk.v}'`);
	}
	const ast = ternary();
	if (peek().k !== 'end') throw new ExprError(`Unexpected '${peek().v}'`);
	return ast;
}

// ── runtime values ──
/** TimeSpan-like view over seconds. */
function timeSpan(sec) {
	sec = Number(sec) || 0;
	return {
		__type: 'TimeSpan', valueOf: () => sec,
		TotalSeconds: sec, TotalMinutes: sec / 60, TotalHours: sec / 3600, TotalDays: sec / 86400, TotalMilliseconds: sec * 1000,
		Days: Math.floor(sec / 86400), Hours: Math.floor(sec / 3600) % 24, Minutes: Math.floor(sec / 60) % 60, Seconds: Math.floor(sec) % 60,
		Milliseconds: Math.floor(sec * 1000) % 1000,
	};
}
function dateTime(ms) {
	const d = new Date(Number(ms) || 0);
	return {
		__type: 'DateTime', valueOf: () => d.getTime(),
		Year: d.getFullYear(), Month: d.getMonth() + 1, Day: d.getDate(), Hour: d.getHours(), Minute: d.getMinutes(),
		Second: d.getSeconds(), DayOfYear: Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5), Ticks: d.getTime() * 10000,
	};
}
const val = (x) => (x && typeof x === 'object' && typeof x.valueOf === 'function' && x.__type) ? x.valueOf() : x;

const STRING_METHODS = {
	Contains: (s, [x, ci]) => (ci ? s.toLowerCase().includes(String(x).toLowerCase()) : s.includes(String(x))),
	StartsWith: (s, [x]) => s.startsWith(String(x)),
	EndsWith: (s, [x]) => s.endsWith(String(x)),
	ToLower: (s) => s.toLowerCase(), ToLowerInvariant: (s) => s.toLowerCase(),
	ToUpper: (s) => s.toUpperCase(), ToUpperInvariant: (s) => s.toUpperCase(),
	Trim: (s) => s.trim(), IndexOf: (s, [x]) => s.indexOf(String(x)),
	Substring: (s, [a, b]) => (b === undefined ? s.substring(a) : s.substr(a, b)),
	Replace: (s, [a, b]) => s.split(String(a)).join(String(b)),
	Equals: (s, [x]) => s === String(x),
};

const STATICS = {
	Regex: {
		IsMatch: ([s, p]) => new RegExp(convertRegex(p)).test(String(s)),
		Match: ([s, p]) => { const m = new RegExp(convertRegex(p)).exec(String(s)); return { Success: !!m, Value: m ? m[0] : '' }; },
	},
	Math: {
		Abs: ([x]) => Math.abs(x), Min: ([a, b]) => Math.min(a, b), Max: ([a, b]) => Math.max(a, b),
		Round: ([x, d]) => (d ? Number(Number(x).toFixed(d)) : Math.round(x)), Floor: ([x]) => Math.floor(x), Ceiling: ([x]) => Math.ceil(x),
		Pow: ([a, b]) => Math.pow(a, b), Sqrt: ([x]) => Math.sqrt(x),
	},
	TimeSpan: {
		FromSeconds: ([x]) => timeSpan(x), FromMinutes: ([x]) => timeSpan(x * 60), FromHours: ([x]) => timeSpan(x * 3600),
	},
	string: { IsNullOrEmpty: ([s]) => !s, IsNullOrWhiteSpace: ([s]) => !s || !String(s).trim() },
	String: { IsNullOrEmpty: ([s]) => !s, IsNullOrWhiteSpace: ([s]) => !s || !String(s).trim() },
};

function convertRegex(p) {
	// .NET inline options (?i) → JS flags aren't inline; support the common case.
	return String(p).replace(/^\(\?i\)/, '');
}

function evaluate(node, scope) {
	switch (node.t) {
		case 'lit': return node.v;
		case 'name':
			if (node.v in scope) return scope[node.v];
			if (node.v in STATICS) return { __static: node.v };
			throw new ExprError(`Unknown name '${node.v}'`);
		case 'member': {
			const o = evaluate(node.obj, scope);
			if (o == null) return null;
			if (o.__static) {
				const v = STATICS[o.__static][node.name];
				if (v === undefined) throw new ExprError(`Unknown member ${o.__static}.${node.name}`);
				return v;
			}
			if (typeof o === 'string') { if (node.name === 'Length') return o.length; }
			if (Array.isArray(o)) { if (node.name === 'Count' || node.name === 'Length') return o.length; }
			if (typeof o === 'object' && node.name in o) return o[node.name];
			throw new ExprError(`Unknown member '${node.name}'`);
		}
		case 'index': {
			const o = evaluate(node.obj, scope);
			const i = evaluate(node.i, scope);
			return o == null ? null : o[i];
		}
		case 'call': {
			const a = node.args.map((x) => evaluate(x, scope));
			if (node.obj.t === 'name' && STATICS[node.obj.v]) {
				const fn = STATICS[node.obj.v][node.name];
				if (!fn) throw new ExprError(`Unknown method ${node.obj.v}.${node.name}`);
				return fn(a);
			}
			const o = evaluate(node.obj, scope);
			if (o == null) return null;
			if (typeof o === 'string') {
				const fn = STRING_METHODS[node.name];
				if (!fn) throw new ExprError(`Unknown string method '${node.name}'`);
				return fn(o, a);
			}
			if (Array.isArray(o)) {
				if (node.name === 'Contains') return o.some((x) => String(x).toLowerCase() === String(a[0]).toLowerCase());
				if (node.name === 'Any') return o.length > 0;
			}
			if (o.__type && node.name === 'ToString') return String(val(o));
			throw new ExprError(`Unknown method '${node.name}'`);
		}
		case 'not': return !truthy(evaluate(node.e, scope));
		case 'neg': return -val(evaluate(node.e, scope));
		case 'and': return truthy(evaluate(node.l, scope)) && truthy(evaluate(node.r, scope));
		case 'or': return truthy(evaluate(node.l, scope)) || truthy(evaluate(node.r, scope));
		case 'cond': return truthy(evaluate(node.cond, scope)) ? evaluate(node.a, scope) : evaluate(node.b, scope);
		case 'bin': {
			const l = val(evaluate(node.l, scope)), r = val(evaluate(node.r, scope));
			switch (node.op) {
				case '==': return l === r || (typeof l === 'string' && typeof r === 'string' && l === r);
				case '!=': return l !== r;
				case '<': return l < r;
				case '<=': return l <= r;
				case '>': return l > r;
				case '>=': return l >= r;
				case '+': return (typeof l === 'string' || typeof r === 'string') ? String(l) + String(r) : l + r;
				case '-': return l - r;
				case '*': return l * r;
				case '/': return r === 0 ? NaN : l / r;
				case '%': return l % r;
				default: throw new ExprError(`Unknown operator ${node.op}`);
			}
		}
		default: throw new ExprError('Invalid expression');
	}
}

function truthy(v) { return !!val(v); }

/** The `item` object an expression sees (VDF DuplicateItem property names + Eagle extras). */
function itemView(d, eagle = {}) {
	return {
		Path: eagle.path || d.path || '',
		Folder: (eagle.folders || []).join('; '),
		Folders: eagle.folders || [],
		Name: d.name || '',
		Extension: d.ext || '',
		SizeLong: d.size || 0,
		Size: d.size || 0,
		Similarity: d.similarity || 0,
		Duration: timeSpan(d.duration),
		FrameSize: d.frameSize || '',
		FrameSizeInt: d.frameSizeInt || 0,
		Format: d.format || '',
		AudioFormat: d.audioFormat || '',
		AudioChannel: d.audioChannel || '',
		AudioSampleRate: d.audioSampleRate || 0,
		AudioBitRateKbs: d.audioBitRateKbs || 0,
		BitRateKbs: d.bitRateKbs || 0,
		Fps: d.fps || 0,
		HdrFormat: d.hdrFormat || '',
		AudioLanguages: d.audioLanguages || '',
		SubtitleLanguages: d.subtitleLanguages || '',
		DateCreated: dateTime(d.dateCreated),
		DateModified: dateTime(d.dateModified),
		IsImage: !!d.isImage,
		IsBestSize: !!d.isBestSize, IsBestDuration: !!d.isBestDuration, IsBestFrameSize: !!d.isBestFrameSize,
		IsBestFps: !!d.isBestFps, IsBestBitRateKbs: !!d.isBestBitRateKbs, IsBestAudioBitRateKbs: !!d.isBestAudioBitRateKbs,
		IsBestAudioSampleRate: !!d.isBestAudioSampleRate, IsBestHdrFormat: !!d.isBestHdrFormat,
		GroupId: d.groupId,
		Flags: d.flags || 0,
		IsFlipped: !!(d.flags & 1), IsPartialClip: !!(d.flags & 2), IsAiMatched: !!(d.flags & 4),
		PartialClipOffset: timeSpan(d.partialOffset || 0),
		IsMissing: !!d.missing, IsDeletedContent: !!d.tombstone,
		// Eagle
		Tags: eagle.tags || [],
		Rating: eagle.star || 0,
		Annotation: eagle.annotation || '',
		Url: eagle.url || '',
		ImportedAt: dateTime(eagle.importedAt || d.dateCreated),
	};
}

/** Compile to a predicate (d, eagleData) → boolean. Throws ExprError with a readable message. */
function compile(src) {
	if (!src || !String(src).trim()) throw new ExprError('Enter an expression');
	const ast = parse(String(src));
	return (d, eagle) => truthy(evaluate(ast, { item: itemView(d, eagle) }));
}

const HELP_PROPERTIES = Object.keys(itemView({}, {}));

module.exports = { compile, parse, tokenize, itemView, ExprError, HELP_PROPERTIES };
