/**
 * @openshaper/io — file readers/writers for OpenShaper.
 *
 * Readers parse legacy/native board files into the pure `@openshaper/kernel`
 * board model; writers (DXF/STL/GCode/PDF/.board.json) are added in later phases.
 *
 * Implemented so far: the legacy BoardCAD-LE native `.brd` reader.
 */
export { parseBrd, parseBrdFile } from './brd-reader';
export type { ParsedBrd, BrdMetadataValue } from './brd-reader';
export { writeBrd } from './brd-writer';
export type { BrdWriteMetadata } from './brd-writer';
export { parseS3d, parseS3dx } from './s3d-reader';
export type { ParsedS3d, ParsedS3dx } from './s3d-reader';
export { decryptBrd, isEncryptedBrd } from './legacy-crypto';
export { parseSrf, SrfReadError } from './srf-reader';
export type { ParsedSrf } from './srf-reader';
export {
  writeBoardJson,
  readBoardJson,
  BoardJsonError,
  BOARD_JSON_VERSION,
  type BoardJson,
} from './board-json';
