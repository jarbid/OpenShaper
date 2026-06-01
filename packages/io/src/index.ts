/**
 * @openshaper/io — file readers/writers for OpenShaper.
 *
 * Readers parse legacy/native board files into the pure `@openshaper/kernel`
 * board model; writers (DXF/STL/GCode/PDF/.board.json) are added in later phases.
 *
 * Implemented so far: the legacy BoardCAD-LE native `.brd` reader.
 */
export { parseBrd } from './brd-reader';
export type { ParsedBrd, BrdMetadataValue } from './brd-reader';
export {
  writeBoardJson,
  readBoardJson,
  BoardJsonError,
  BOARD_JSON_VERSION,
  type BoardJson,
} from './board-json';
