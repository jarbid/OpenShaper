// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The tessellation worker's messages, and what it does with each — a pure function
 * so the protocol can be tested without a Worker (`tessellate.worker.ts` is only
 * the `onmessage` shell around it).
 *
 * Three jobs: the viewport mesh, the exact curvature analysis (`curvature-mesh.ts`)
 * and the deviation from a ghost board (`deviation-mesh.ts`). `BezierBoard` is plain
 * readonly data, so it travels by structured clone; every typed array in a result is
 * transferred back (zero-copy).
 */
import { tessellateBoard, type BezierBoard, type BoardMesh } from '@openshaper/kernel';
import { boardCurvatureMesh, curvatureTransferables, type CurvatureMesh } from './curvature-mesh';
import { boardDeviationMesh, deviationTransferables, type DeviationMesh } from './deviation-mesh';
import type { WorkerReply } from './mesh-queue';

export type WorkerRequest =
  | { kind: 'mesh'; id: number; board: BezierBoard; targetFaceSize: number }
  | { kind: 'curvature'; id: number; board: BezierBoard }
  | {
      kind: 'deviation';
      id: number;
      board: BezierBoard;
      ghost: BezierBoard;
      targetFaceSize: number;
    };

export interface HandledRequest {
  reply: WorkerReply<BoardMesh> | WorkerReply<CurvatureMesh> | WorkerReply<DeviationMesh>;
  /** Buffers to transfer with the reply. */
  transfer: ArrayBuffer[];
}

export const handleWorkerRequest = (req: WorkerRequest): HandledRequest => {
  try {
    if (req.kind === 'curvature') {
      const result = boardCurvatureMesh(req.board);
      return { reply: { id: req.id, result }, transfer: curvatureTransferables(result) };
    }
    if (req.kind === 'deviation') {
      const result = boardDeviationMesh(req.board, req.ghost, req.targetFaceSize);
      return { reply: { id: req.id, result }, transfer: deviationTransferables(result) };
    }
    const result = tessellateBoard(req.board, { targetFaceSize: req.targetFaceSize });
    return {
      reply: { id: req.id, result },
      transfer: [result.positions.buffer, result.normals.buffer, result.indices.buffer].map(
        (b) => b as ArrayBuffer,
      ),
    };
  } catch (err) {
    // Report it, so the caller's promise settles and the queue moves on to the
    // next board instead of waiting for a reply that will never come.
    return {
      reply: { id: req.id, error: err instanceof Error ? err.message : String(err) },
      transfer: [],
    };
  }
};
