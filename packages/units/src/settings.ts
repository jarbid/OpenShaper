/**
 * Mutable display-unit preferences, mirroring the legacy `UnitUtils` static
 * state (`mSelectedUnit`, `mFractionAccuracy`, `mNrOfDecimals`) and the
 * `convert*ToCurrentUnit` convenience wrappers.
 *
 * The core formatting/parsing functions in `format.ts` / `parse.ts` are PURE
 * and take explicit options — prefer those in new code. This module exists so
 * the legacy call sites have a faithful, drop-in equivalent. State is held in a
 * single object instance rather than as a global singleton.
 */

import { Unit } from './constants.js';
import {
  DEFAULT_FRACTION_ACCURACY,
  DEFAULT_NR_OF_DECIMALS,
  convertAreaToUnit,
  convertDensityToUnit,
  convertLengthToUnit,
  convertMomentOfInertiaToUnit,
  convertVolumeToUnit,
  convertWeightToUnit,
} from './format.js';
import {
  convertInputStringToInternalDensityUnit,
  convertInputStringToInternalLengthUnit,
  convertInputStringToInternalVolumeUnit,
  convertInputStringToInternalWeightUnit,
} from './parse.js';

export class UnitSettings {
  private selectedUnit: Unit;
  private fractionAccuracy: number;
  private nrOfDecimals: number;

  constructor(
    selectedUnit: Unit = Unit.INCHES,
    fractionAccuracy: number = DEFAULT_FRACTION_ACCURACY,
    nrOfDecimals: number = DEFAULT_NR_OF_DECIMALS,
  ) {
    this.selectedUnit = selectedUnit;
    this.fractionAccuracy = fractionAccuracy;
    this.nrOfDecimals = nrOfDecimals;
  }

  setCurrentUnit(unit: Unit): void {
    this.selectedUnit = unit;
  }

  getCurrentUnit(): Unit {
    return this.selectedUnit;
  }

  setFractionAccuracy(accuracy: number): void {
    this.fractionAccuracy = accuracy;
  }

  getFractionAccuracy(): number {
    return this.fractionAccuracy;
  }

  setNrOfDecimals(nrOfDecimals: number): void {
    this.nrOfDecimals = nrOfDecimals;
  }

  getNrOfDecimals(): number {
    return this.nrOfDecimals;
  }

  // --- parse (input string -> internal unit) ---

  convertInputStringToInternalLengthUnit(string: string): number {
    return convertInputStringToInternalLengthUnit(string, this.selectedUnit);
  }

  convertInputStringToInternalWeightUnit(string: string): number {
    return convertInputStringToInternalWeightUnit(string, this.selectedUnit);
  }

  convertInputStringToInternalVolumeUnit(string: string): number {
    return convertInputStringToInternalVolumeUnit(string);
  }

  convertInputStringToInternalDensityUnit(string: string): number {
    return convertInputStringToInternalDensityUnit(string, this.selectedUnit);
  }

  // --- format (internal unit -> display string) ---

  convertLengthToCurrentUnit(value: number, useLargeUnits: boolean): string {
    return convertLengthToUnit(
      value,
      useLargeUnits,
      this.selectedUnit,
      this.fractionAccuracy,
      this.nrOfDecimals,
    );
  }

  convertAreaToCurrentUnit(value: number): string {
    return convertAreaToUnit(value, this.selectedUnit);
  }

  convertVolumeToCurrentUnit(value: number): string {
    return convertVolumeToUnit(value, this.selectedUnit);
  }

  convertWeightToCurrentUnit(value: number, useSmallUnits: boolean): string {
    return convertWeightToUnit(value, useSmallUnits, this.selectedUnit);
  }

  convertDensityToCurrentUnit(value: number): string {
    return convertDensityToUnit(value, this.selectedUnit);
  }

  convertMomentOfInertiaToCurrentUnit(value: number): string {
    return convertMomentOfInertiaToUnit(value, this.selectedUnit);
  }
}
