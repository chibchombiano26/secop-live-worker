import { describe, it, expect } from "vitest";
import {
  compareNumericRule,
  normalizeFinding,
  assessmentReadiness,
} from "../src/dossier/assessment";
const requirement: any = {
  id: "r1",
  mandatory: true,
  rule: {
    field: "liquidity",
    operator: "gte",
    value: 1.5,
    unit: "ratio",
    period: "2025",
  },
  lot: null,
};
const fact: any = {
  field: "liquidity",
  value: 1.5,
  unit: "ratio",
  period: "2025",
  reviewed: true,
  citations: [
    { documentVersionId: "financials", page: 1, excerpt: "Liquidity 1.5" },
  ],
};
const chunk: any = {
  documentVersionId: "financials",
  page: 1,
  text: "Liquidity 1.5",
  index: 0,
};
describe("company fit evidence and deterministic thresholds", () => {
  it("uses exact thresholds and matching periods/units with reviewed facts", () => {
    expect(compareNumericRule(requirement.rule, fact)).toBe("meets");
    expect(compareNumericRule({ ...requirement.rule, value: 1.6 }, fact)).toBe(
      "does_not_meet",
    );
    expect(
      compareNumericRule(requirement.rule, { ...fact, period: "2024" }),
    ).toBe("insufficient_evidence");
    expect(
      compareNumericRule(requirement.rule, { ...fact, reviewed: false }),
    ).toBe("insufficient_evidence");
    expect(compareNumericRule(requirement.rule, { ...fact, unit: "COP" })).toBe(
      "insufficient_evidence",
    );
  });
  it("cannot meet without company evidence, with expired evidence, or with invented citations", () => {
    const result: any = {
      status: "meets",
      reason: "OK",
      missing: [],
      companyCitations: [],
    };
    expect(
      normalizeFinding(requirement, result, [], new Set(), []).status,
    ).toBe("insufficient_evidence");
    expect(
      normalizeFinding(
        requirement,
        { ...result, companyCitations: fact.citations },
        [chunk],
        new Set(["financials"]),
        [],
      ).status,
    ).toBe("insufficient_evidence");
    expect(() =>
      normalizeFinding(
        requirement,
        { ...result, companyCitations: [{ ...fact.citations[0], page: 99 }] },
        [chunk],
        new Set(),
        [],
      ),
    ).toThrow();
  });
  it("rejects unsubstantiated not-applicable findings and prevents ready with incomplete coverage or missing requirements", () => {
    expect(
      normalizeFinding(
        requirement,
        {
          status: "not_applicable",
          reason: "Unknown",
          missing: [],
          companyCitations: [],
        },
        [],
        new Set(),
        [],
      ).status,
    ).toBe("insufficient_evidence");
    expect(
      assessmentReadiness([{ mandatory: true, status: "meets" }], false, false),
    ).toBe("requires_review");
    expect(
      assessmentReadiness(
        [{ mandatory: true, status: "insufficient_evidence" }],
        true,
        false,
      ),
    ).toBe("missing_requirements");
    expect(
      assessmentReadiness([{ mandatory: true, status: "meets" }], true, false),
    ).toBe("ready_for_user_review");
    expect(
      assessmentReadiness([{ mandatory: true, status: "meets" }], true, true),
    ).toBe("requires_review");
  });
});
