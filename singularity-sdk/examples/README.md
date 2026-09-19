# Examples

Runnable against public endpoints, with no key and no signer. From the repository root:

```bash
npm install && npm run build
npx tsx singularity-sdk/examples/portfolio.ts
npx tsx singularity-sdk/examples/liveness-monitor.ts
npx tsx singularity-sdk/examples/burn-flow.ts
npx tsx singularity-sdk/examples/agent-tools.ts
```

| File | What it shows |
|---|---|
| `portfolio.ts` | One address across four families, and how to read a completeness envelope. |
| `liveness-monitor.ts` | `watch.liveness` and `watch.tip`, with backoff and clean shutdown. |
| `burn-flow.ts` | Build → inspect → hand off. The whole custody seam, without a signer. |
| `agent-tools.ts` | The tool catalogue in three shapes, with a policy hook in front. |
