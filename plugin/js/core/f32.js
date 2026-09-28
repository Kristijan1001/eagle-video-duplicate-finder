'use strict';
// VDF does its matching arithmetic in C# `float` (IEEE-754 binary32). JavaScript numbers
// are binary64, so a naive port can land on the other side of a threshold for borderline
// pairs. Every float operation that feeds a verdict goes through these helpers so the
// rounding matches the C# expression it was ported from, step by step.

const f = Math.fround;

module.exports = {
	f,
	/** float + float */
	add: (a, b) => f(f(a) + f(b)),
	/** float - float */
	sub: (a, b) => f(f(a) - f(b)),
	/** float * float */
	mul: (a, b) => f(f(a) * f(b)),
	/** float / float */
	div: (a, b) => f(f(a) / f(b)),
	/** `Settings.Percent / 100f` */
	percentToUnit: (percent) => f(f(percent) / 100),
	/** `1.0f - Settings.Percent / 100f` */
	oneMinusPercent: (percent) => f(1 - f(f(percent) / 100)),
};
