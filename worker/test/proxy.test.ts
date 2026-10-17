import { describe, expect, it } from "vitest";
import { keyValid } from "../src/cache";
import {
  buildDocsQuery,
  buildProcesosQuery,
  colombianFloatingTimestamp,
  esc,
  like,
  page,
  wordsAny,
} from "../src/socrata";

describe("soql", () => {
  it("escapes quotes", () => {
    expect(esc("l'hopital")).toBe("l''hopital");
  });
  it("like is case-insensitive contains", () => {
    expect(like("entidad", "hospital")).toContain(
      "upper(entidad) like '%HOSPITAL%'",
    );
  });
  it("wordsAny ANDs words across columns", () => {
    const q = wordsAny(
      ["nombre_archivo", "descripci_n"],
      "suministro alimentos",
    );
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
  it("vigentes filters future Colombian floating deadlines before paging and orders nearest first", () => {
    const now = new Date("2026-10-17T15:30:45.000Z");
    expect(colombianFloatingTimestamp(now)).toBe("2026-10-17T10:30:45");
    const q = buildProcesosQuery({ vigentes: true, limit: 5, offset: 10 }, now);
    expect(q).toContain("fecha_de_recepcion_de > '2026-10-17T10:30:45'");
    expect(q).toContain("upper(estado_del_procedimiento) NOT IN ('CANCELADO'");
    expect(q).toContain("'SELECCIONADO'");
    expect(q).toContain("'SUSPENDIDO'");
    expect(q).toContain("ORDER BY fecha_de_recepcion_de ASC, :id LIMIT 5 OFFSET 10");
  });
  it("keeps all-search query behavior unchanged when vigentes is absent or false", () => {
    const baseline = buildProcesosQuery({ limit: 5 });
    expect(buildProcesosQuery({ limit: 5, vigentes: false })).toBe(baseline);
    expect(baseline).toBe(
      "SELECT *, :id  ORDER BY fecha_de_publicacion_del DESC, :id LIMIT 5 OFFSET 0",
    );
  });
  it("docs query filters by words", () => {
    const q = buildDocsQuery("pliego", undefined, 10, 20);
    expect(q).toContain("LIMIT 10 OFFSET 20");
  });
  it("page math", () => {
    expect(page([1, 2], 2, 0)).toMatchObject({
      next_offset: 2,
      prev_offset: null,
    });
    expect(page([1], 2, 4)).toMatchObject({
      next_offset: null,
      prev_offset: 2,
    });
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
