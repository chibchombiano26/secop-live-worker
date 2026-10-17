import { DurableObject } from "cloudflare:workers";
interface Env {
  OCR_CONTAINER: DurableObjectNamespace<CpuOcrContainer>;
}
/** A single private instance bounds aggregate CPU use. No public HTTP route. */
export class CpuOcrContainer extends DurableObject<Env> {
  private busy = false;
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/v1/extract"
    )
      return new Response("Not found", { status: 404 });
    if (request.headers.get("content-type") !== "application/pdf")
      return new Response("PDF required", { status: 415 });
    if (this.busy) return Response.json({ error: "OCR_BUSY" }, { status: 429 });
    this.busy = true;
    const container = this.ctx.container!;
    try {
      await container.setInactivityTimeout(120000);
      if (!container.running) container.start({ enableInternet: false });
      const port = container.getTcpPort(8080);
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          const health = await port.fetch("http://container/health");
          if (health.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready)
        return Response.json({ error: "OCR_STARTING" }, { status: 503 });
      const body = await request.arrayBuffer();
      if (body.byteLength > 25 * 1024 * 1024)
        return Response.json({ error: "OCR_FILE_LIMIT" }, { status: 413 });
      const response = await port.fetch(
        new Request("http://container/v1/extract", {
          method: "POST",
          headers: {
            "content-type": "application/pdf",
            "content-length": String(body.byteLength),
          },
          body,
        }),
      );
      // Consume response before releasing concurrency or scheduling sleep.
      const bytes = await response.arrayBuffer();
      return new Response(bytes, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    } catch {
      return Response.json({ error: "OCR_UNAVAILABLE" }, { status: 503 });
    } finally {
      this.busy = false;
      await container.setInactivityTimeout(10000);
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.OCR_CONTAINER.getByName("cpu-ocr").fetch(request);
  },
} satisfies ExportedHandler<Env>;
