/**
 * Off-main-thread board tessellation. The kernel mesh build walks every station
 * interpolating a cross-section — heavy at fine target-face sizes — so we run it in
 * a worker to keep editing responsive (project principle #4: the UI never blocks).
 *
 * `BezierBoard` is plain readonly data, so it travels by structured clone with no
 * manual serialization. The resulting typed arrays are transferred back (zero-copy).
 */
import { tessellateBoard, type BezierBoard } from '@openshaper/kernel';

interface Req {
  id: number;
  board: BezierBoard;
  targetFaceSize: number;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, board, targetFaceSize } = e.data;
  const mesh = tessellateBoard(board, { targetFaceSize });
  (self as unknown as Worker).postMessage({ id, mesh }, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.indices.buffer,
  ]);
};
