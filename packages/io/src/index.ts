/**
 * @board-studio/io — file readers/writers for Board Studio.
 *
 * Readers parse legacy/native board files into the pure `@board-studio/kernel`
 * board model; writers (DXF/STL/GCode/PDF/.board.json) are added in later phases.
 *
 * Implemented so far: the legacy BoardCAD-LE native `.brd` reader.
 */
export { parseBrd } from './brd-reader';
export type { ParsedBrd, BrdMetadataValue } from './brd-reader';
