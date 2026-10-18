import { instrument } from "@flue/runtime";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import { budgetAgentInference } from "./dossier/agent-budget";
import type { ProcessingEnv } from "./dossier/processing";
instrument({
  key: Symbol.for("secop-agent-budgets"),
  observe: () => {},
  dispose: () => {},
  interceptor: async (operation, context, next) => {
    if (operation.type === "model") {
      const env = (context.eventContext?.env ??
        getCloudflareContext().env) as ProcessingEnv;
      await budgetAgentInference(
        env,
        context.instanceId ?? context.eventContext?.id ?? "",
      );
    }
    return next();
  },
});
import backend from "./index";
// Agent dispatch is internal. No public Flue routes are mounted.
export default { fetch: backend.fetch };
