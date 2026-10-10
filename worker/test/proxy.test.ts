import { describe, expect, it } from "vitest";
import { keyValid } from "../src/cache";
import { buildDocsQuery, buildProcesosQuery, esc, like, page, wordsAny } from "../src/socrata";

describe("soql", () => {
  it("escapes quotes", () => {
    expect(esc("l'hopital")).toBe("l''hopital");
  });
  it("like is case-insensitive contains", () => {
    expect(like("entidad", "hospital")).toContain("upper(entidad) like '%HOSPITAL%'");
  });
  it("wordsAny ANDs words across columns", () => {
    const q = wordsAny(["nombre_archivo", "descripci_n"], "suministro alimentos");
    expect(q).toContain("upper(nombre_archivo) like '%SUMINISTRO%'");
    expect(q).toContain("upper(descripci_n) like '%ALIMENTOS%'");
    expect(q).toContain(" AND ");
  });
  it("procesos query orders stably with :id", () => {
    const q = buildProcesosQuery({ estado: "Publicado", limit: 5 });
    expect(q).toContain("estado_del_procedimiento = 'Publicado'");
    expect(q).toContain("ORDER BY fecha_de_publicacion_del DESC, :id");
    expect(q).toContain("LIMIT 5 OFFSET 0");
  });
  it("docs query filters by words", () => {
    const q = buildDocsQuery("pliego", undefined, 10, 20);
    expect(q).toContain("LIMIT 10 OFFSET 20");
  });
  it("page math", () => {
    expect(page([1, 2], 2, 0)).toMatchObject({ next_offset: 2, prev_offset: null });
    expect(page([1], 2, 4)).toMatchObject({ next_offset: null, prev_offset: 2 });
  });
});

describe("auth", () => {
  it("open without keys configured", () => {
    expect(keyValid({}, null)).toBe(true);
  });
  it("rejects wrong key", () => {
    expect(keyValid({ API_KEYS: "a,b" }, "c")).toBe(false);
    expect(keyValid({ API_KEYS: "a,b" }, "a")).toBe(true);
  });
});
