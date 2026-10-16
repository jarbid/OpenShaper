// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The attribute count of every entity the writer emits (design §14): OCCT only
 * warns about a malformed instance, so the subset reader (`read.ts`) enforces this
 * table and the tests pin it against what the writer produces.
 *
 * Counts are the AP214 `AUTOMOTIVE_DESIGN` explicit attributes including inherited
 * ones, in the order the writer emits them. A partial entity of a complex instance
 * (a supertype slice such as `B_SPLINE_CURVE`) has its own count, so a name that
 * is both (`B_SPLINE_CURVE_WITH_KNOTS`) appears in both tables.
 */

/** Simple entities: name → number of attributes. */
export const SIMPLE_ARITY: Readonly<Record<string, number>> = Object.freeze({
  APPLICATION_CONTEXT: 1,
  APPLICATION_PROTOCOL_DEFINITION: 4,
  PRODUCT_CONTEXT: 3,
  PRODUCT: 4,
  PRODUCT_DEFINITION_FORMATION: 3,
  PRODUCT_DEFINITION_CONTEXT: 3,
  PRODUCT_DEFINITION: 4,
  PRODUCT_DEFINITION_SHAPE: 3,
  PRODUCT_RELATED_PRODUCT_CATEGORY: 3,
  DIMENSIONAL_EXPONENTS: 7,
  LENGTH_MEASURE_WITH_UNIT: 2,
  UNCERTAINTY_MEASURE_WITH_UNIT: 4,
  CARTESIAN_POINT: 2,
  DIRECTION: 2,
  AXIS2_PLACEMENT_3D: 4,
  B_SPLINE_CURVE_WITH_KNOTS: 9,
  B_SPLINE_SURFACE_WITH_KNOTS: 13,
  DEFINITIONAL_REPRESENTATION: 3,
  PCURVE: 3,
  SURFACE_CURVE: 4,
  SEAM_CURVE: 4,
  VERTEX_POINT: 2,
  EDGE_CURVE: 5,
  ORIENTED_EDGE: 5,
  EDGE_LOOP: 2,
  FACE_OUTER_BOUND: 3,
  FACE_BOUND: 3,
  ADVANCED_FACE: 4,
  CLOSED_SHELL: 2,
  MANIFOLD_SOLID_BREP: 2,
  ADVANCED_BREP_SHAPE_REPRESENTATION: 3,
  SHAPE_DEFINITION_REPRESENTATION: 2,
});

/** Partial entities of complex instances: name → number of attributes. */
export const PARTIAL_ARITY: Readonly<Record<string, number>> = Object.freeze({
  // units and contexts
  LENGTH_UNIT: 0,
  NAMED_UNIT: 1,
  SI_UNIT: 2,
  CONVERSION_BASED_UNIT: 2,
  PLANE_ANGLE_UNIT: 0,
  SOLID_ANGLE_UNIT: 0,
  GEOMETRIC_REPRESENTATION_CONTEXT: 1,
  GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT: 1,
  GLOBAL_UNIT_ASSIGNED_CONTEXT: 1,
  PARAMETRIC_REPRESENTATION_CONTEXT: 0,
  REPRESENTATION_CONTEXT: 2,
  // rational B-spline curves and surfaces
  BOUNDED_CURVE: 0,
  B_SPLINE_CURVE: 5,
  B_SPLINE_CURVE_WITH_KNOTS: 3,
  CURVE: 0,
  RATIONAL_B_SPLINE_CURVE: 1,
  BOUNDED_SURFACE: 0,
  B_SPLINE_SURFACE: 7,
  B_SPLINE_SURFACE_WITH_KNOTS: 5,
  RATIONAL_B_SPLINE_SURFACE: 1,
  SURFACE: 0,
  GEOMETRIC_REPRESENTATION_ITEM: 0,
  REPRESENTATION_ITEM: 1,
});
