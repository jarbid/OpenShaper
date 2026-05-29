/**
 * `@board-studio/units` — metric/imperial unit conversion and fraction-accurate
 * formatting, ported from the legacy `cadcore.UnitUtils` (BoardCAD-LE).
 *
 * The internal length unit is the CENTIMETER. Pure functions take explicit
 * options; `UnitSettings` provides a faithful drop-in for the legacy stateful
 * `convert*ToCurrentUnit` API.
 */

export * from './constants.js';
export * from './parse.js';
export * from './format.js';
export { UnitSettings } from './settings.js';
