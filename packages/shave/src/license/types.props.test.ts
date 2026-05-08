// SPDX-License-Identifier: MIT
// Vitest harness for license/types.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_types_acceptedLicense_literalUnionShape,
  prop_types_licenseDetection_evidenceFieldOmittable,
  prop_types_licenseDetection_requiredFieldsPresent,
  prop_types_licenseDetection_sourceIsAllowedLiteral,
  prop_types_licenseGateResult_acceptedFalseBranchShape,
  prop_types_licenseGateResult_acceptedTrueBranchShape,
  prop_types_licenseGateResult_discriminantDrivesBranch,
} from "./types.props.js";

const opts = { numRuns: 100 };

it("property: AcceptedLicense — literal union accepts exactly the 8 allowed strings", () => {
  fc.assert(prop_types_acceptedLicense_literalUnionShape, opts);
});

it("property: LicenseDetection — required fields identifier and source are present", () => {
  fc.assert(prop_types_licenseDetection_requiredFieldsPresent, opts);
});

it("property: LicenseDetection — evidence field is omittable (exactOptionalPropertyTypes)", () => {
  fc.assert(prop_types_licenseDetection_evidenceFieldOmittable, opts);
});

it("property: LicenseDetection — source is one of the 5 allowed literals", () => {
  fc.assert(prop_types_licenseDetection_sourceIsAllowedLiteral, opts);
});

it("property: LicenseGateResult — accepted:true branch has license and detection fields", () => {
  fc.assert(prop_types_licenseGateResult_acceptedTrueBranchShape, opts);
});

it("property: LicenseGateResult — accepted:false branch has reason and detection fields", () => {
  fc.assert(prop_types_licenseGateResult_acceptedFalseBranchShape, opts);
});

it("property: LicenseGateResult — discriminant drives branch (compound)", () => {
  fc.assert(prop_types_licenseGateResult_discriminantDrivesBranch, opts);
});
