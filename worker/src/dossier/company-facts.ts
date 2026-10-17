import { z } from "zod/v4";
import { companyEvidence, factSchema, type CompanyFact } from "./companies";
import { validateCitations } from "./synthesis";
import { DossierError } from "./contracts";
import type { DossierRepository } from "./repository";
import type { ModelProvider } from "./model";
export async function extractCompanyFacts(
  repo: DossierRepository,
  companyId: string,
  model: ModelProvider,
) {
  const source = await companyEvidence(repo, companyId);
  const candidates: CompanyFact[] = [];
  for (const chunk of source.chunks.filter(
    (c) => !source.expired.has(c.documentVersionId),
  )) {
    const result = z
      .object({ facts: z.array(factSchema.omit({ reviewed: true })).max(100) })
      .parse(
        await model.generate({
          purpose: "company_facts",
          outputSchema: z.toJSONSchema(
            z.object({
              facts: z.array(factSchema.omit({ reviewed: true })).max(100),
            }),
          ),
          evidence: [chunk],
          instructions:
            "Return {facts:[{field,value:number,unit,period:string|null,citations:[{documentVersionId,page?,section?,excerpt}]}]}. Extract explicitly stated company numerical facts (financial ratios, contract counts/amounts, years of experience). Use stable field names liquidity, indebtedness, working_capital, equity, contract_count, experience_years where applicable. Preserve fiscal periods and currency/ratio units. Never infer missing facts or compute unsupported totals. Facts are candidates requiring user review.",
        }),
      );
    for (const fact of result.facts) {
      fact.citations = validateCitations(fact.citations, [chunk]);
      candidates.push({ ...fact, reviewed: false });
    }
  }
  const current = await repo.read<typeof source.company.value>(
    "company",
    companyId,
  );
  if (current.revision !== source.company.revision)
    throw new DossierError("COMPANY_CHANGED", 409);
  const existing = source.company.value.facts;
  const key = (f: CompanyFact) =>
    JSON.stringify({
      field: f.field,
      value: f.value,
      unit: f.unit,
      period: f.period,
      citations: f.citations,
    });
  const keys = new Set(existing.map(key));
  const added = candidates.filter((f) => {
    const k = key(f);
    if (keys.has(k)) return false;
    keys.add(k);
    return true;
  });
  if (!added.length) return source.company;
  if (existing.length + added.length > 200)
    throw new DossierError("COMPANY_FACT_LIMIT", 413);
  return repo.save(
    "company",
    companyId,
    { ...current.value, facts: [...existing, ...added] },
    current.revision,
  );
}
