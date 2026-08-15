'use strict';

/*
 * Pace: usage measured against the clock.
 *
 * A limit window is a budget over a fixed span, so spending it evenly means the
 * percentage used tracks the fraction of the window elapsed. Running ahead of
 * the clock is the early warning that matters, and it is available long before
 * the number itself looks alarming.
 *
 * Nothing here predicts behaviour. It answers one question — "if the last while
 * continues, where does this window end up?" — from the window bounds and the
 * current percentage, and says nothing at all when the window is too young for
 * that answer to mean anything.
 */

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

/** Window bounds derived from a known reset moment. */
function boundsFromEnd(endMs, spanMs) {
  return endMs ? { startMs: endMs - spanMs, endMs } : null;
}

/**
 * Where the projection lands, as a coarse verdict the UI can colour by.
 * "tight" means the window runs out shortly before the reset; "over" means well
 * before it.
 */
function levelFor(projected, value) {
  if (value <= 0) return 'idle';
  if (projected > 130) return 'over';
  if (projected > 100) return 'tight';
  if (projected > 70) return 'onTrack';
  return 'relaxed';
}

/**
 * @param {object} opts
 * @param {number} opts.value    percentage of the window used so far
 * @param {number} opts.startMs  when the window opened
 * @param {number} opts.endMs    when it resets
 * @param {number} [opts.now]
 * @returns {null | {elapsed:number, projected:number, exhaustAt:number|null, level:string}}
 *   elapsed is a fraction 0..1 (also the marker position on a bar), projected is
 *   the end-of-window percentage at the current rate, exhaustAt is when 100% is
 *   reached — null unless that happens before the reset.
 */
function pace(opts) {
  const value = Number(opts && opts.value);
  const startMs = opts && opts.startMs;
  const endMs = opts && opts.endMs;
  const now = (opts && opts.now) || Date.now();

  if (!Number.isFinite(value) || !startMs || !endMs || endMs <= startMs) return null;

  const span = endMs - startMs;
  const elapsed = (now - startMs) / span;
  // Early in a window the rate is dominated by rounding rather than by usage:
  // one percent over two minutes projects to an absurd number. Say nothing.
  if (elapsed < 0.03 || elapsed > 1) return null;

  const projected = value / elapsed;
  const exhaustAt = value > 0 && projected > 100 ? startMs + span * elapsed * (100 / value) : null;

  return { elapsed, projected, exhaustAt, level: levelFor(projected, value) };
}

module.exports = { pace, boundsFromEnd, levelFor, FIVE_HOURS, SEVEN_DAYS };
