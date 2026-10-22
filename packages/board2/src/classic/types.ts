// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Types of the classic converter and the deviation report
 * (docs/design/board2.md §9, §10, §12.2, §12.3). Type-only module.
 *
 * This directory is the only part of `@openshaper/board2` allowed to import
 * `@openshaper/kernel` (§11.3); the core never imports it.
 */
import type { BezierBoard } from '@openshaper/kernel';
import type { BoardDoc, BuiltBoard, RailLawValues } from '../types';

/** The classic board a conversion or report starts from (any reader's output). */
export type ClassicBoard = BezierBoard;

// ---------------------------------------------------------------------------
// Converter (§9, §12.2)
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  /** Plan loop and stringer-line fit target, cm. */
  readonly lineTol: number;
  /** Deck and bottom fit target outside crease and tip windows, cm. */
  readonly surfaceTol: number;
  /** Inset keys as fractions of the local half-width. */
  readonly deckInsetFraction: number;
  readonly tuckInsetFraction: number;
  /** A non-continuous classic knot turning less than this (radians) is smooth. */
  readonly cornerAngleMin: number;
  /** Plan corner fillet radius, cm. */
  readonly cornerFilletRadius: number;
  /** Classic loft sampling: row spacing in x (cm) and ring points per half. */
  readonly sampleSpacingX: number;
  readonly ringSamples: number;
  /** Arc-length spacing of the exact outline and stringer-line samples, cm (S6). */
  readonly lineSampleSpacing: number;
  /** One-sided difference step for classic crease angles, cm. */
  readonly creaseProbe: number;
  /** Stringer-line samples start this far inside each end, cm. */
  readonly endGap: number;
  /** Starting knot spacing of the deck and bottom, cm. */
  readonly surfaceKnotSpacing: { readonly x: number; readonly y: number };
  /** Refinement never goes below this knot spacing in x, cm. */
  readonly minKnotSpacing: number;
  /** Half-widths of the windows excluded from refinement and attributed in the report, cm. */
  readonly creaseWindow: number;
  readonly tipWindow: number;
  /** Classic data kept outside the inset loops, cm. */
  readonly trimDataMargin: number;
  readonly maxRefinePasses: number;
  readonly bandCorrectionPasses: number;
  /** Fairness search (§9.8): ratio bracket to the data term and bisection steps. */
  readonly fairnessRatioBracket: readonly [number, number];
  readonly fairnessSearchSteps: number;
}

/** The result of a conversion: the master doc, its build, and what the fit achieved. */
export interface Conversion {
  readonly doc: BoardDoc;
  readonly built: BuiltBoard;
  readonly report: ConversionReport;
}

export interface ConversionReport {
  /** Achieved fit errors per stage, cm. */
  readonly planError: number;
  readonly rockerError: number;
  readonly deckLineError: number;
  readonly deckSurfaceError: number;
  readonly bottomSurfaceError: number;
  readonly bandError: number;
  /** Classic outline corners replaced by fillets: where, radius, predicted plan deviation. */
  readonly fillets: readonly {
    readonly x: number;
    readonly radius: number;
    readonly predictedDeviation: number;
  }[];
  /** x-ranges the classic floors (MIN_DIM) and the stations where board2 floored the rail height. */
  readonly floorZones: readonly (readonly [number, number])[];
  readonly railHeightFloored: readonly number[];
  /** Classic crease angle per real station (radians), by station x. */
  readonly creases: readonly { readonly x: number; readonly angle: number }[];
  /**
   * The laws measured (§5.7) on the fitted band at the real classic stations
   * (σ on the −y half, board2 x), before they are clamped into the lanes' keys.
   */
  readonly stationLaws: readonly {
    readonly sigma: number;
    readonly x: number;
    readonly laws: RailLawValues;
  }[];
  /**
   * Largest control-point coordinate difference between the document's built
   * band and the fitted band: the factorisation identity (§9.7 item 6), cm.
   */
  readonly factorisationError: number;
  /** The band fit (§9.7, S7 as built). */
  readonly band: {
    /** Fairness ratio of the fit (§9.8; NaN when the initial band was kept). */
    readonly ratio: number;
    /** Parameter-correction passes the fit made. */
    readonly corrections: number;
    /** Rail samples, and the refitted band's largest projected distance over the judged ones and over all (cm). */
    readonly samples: number;
    readonly judgedMax: number;
    readonly allMax: number;
    readonly meets: boolean;
    /** Band columns of the fit (the station basis). */
    readonly columns: number;
    /** Apex keys beyond the stations and tips: repairs of the initial law, and the extraction's. */
    readonly initialApexKeysAdded: number;
    readonly apexKeysAdded: number;
    /** Inset keys the initial band's repairs added (both insets halved where no apex fits, §5.3). */
    readonly insetKeysAdded: number;
  };
  /** Band columns and refinement passes of the built board. */
  readonly builtColumns: number;
  readonly builtPasses: number;
  readonly timings: { readonly [stage: string]: number };
}

// ---------------------------------------------------------------------------
// Deviation report (§10, §12.3)
// ---------------------------------------------------------------------------

export interface DeviationOptions {
  readonly reportSpacingX: number;
  readonly reportRing: number;
  readonly boardChord: number;
  readonly unexplainedMax: number;
  readonly creaseAngleMin: number;
  readonly volumeBudgetTol: number;
  readonly specTol: {
    readonly length: number;
    readonly width: number;
    readonly thickness: number;
    /** Relative. */
    readonly volume: number;
  };
}

/** Why a sample or a spec differs from the classic engine (§10.3, §10.4). */
export type DeviationCause =
  | 'station-crease'
  | 'tip'
  | 'corner-fillet'
  | 'profile-corner'
  | 'fit'
  | 'classic-model-split'
  | 'classic-quadrature'
  | 'classic-defect';

/** Signed distances, positive where board2 lies outside the classic surface. */
export interface DistanceSamples {
  /** Sample positions, stride 3. */
  readonly points: readonly number[];
  readonly distance: readonly number[];
  readonly cause: readonly DeviationCause[];
  readonly max: number;
  readonly rms: number;
}

export interface SpecDelta {
  readonly spec: 'length' | 'width' | 'thickness' | 'planArea' | 'volume' | 'centreOfMassX';
  readonly classic: number;
  readonly board2: number;
  readonly delta: number;
  readonly withinTolerance: boolean;
  /** Each cause's share of `delta`, in the spec's unit. */
  readonly explained: readonly { readonly cause: DeviationCause; readonly amount: number }[];
}

export interface DeviationReport {
  readonly classicToBoard2: DistanceSamples;
  /** In-plane distances: an upper bound of the 3D distance (§10.1). */
  readonly board2ToClassic: DistanceSamples;
  readonly specs: readonly SpecDelta[];
  readonly volume: {
    /** The classic loft's own volume and the spec panel's (cm³). */
    readonly loft: number;
    readonly specPanel: number;
    /** The first-order budget: ∮ d dA over the classic surface, split by cause (cm³). */
    readonly budget: number;
    readonly budgetByCause: readonly { readonly cause: DeviationCause; readonly amount: number }[];
    readonly budgetHolds: boolean;
  };
  /** Samples above `unexplainedMax` with cause `fit`: must be 0 for the report to pass. */
  readonly unexplained: number;
  readonly passed: boolean;
}
