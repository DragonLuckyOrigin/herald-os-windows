# Preferred-model browser regression fixture

This fixture renders the real `AgentsSection` and model-provider store. Only the gateway boundary and Electron-facing APIs return synthetic data. No Electron, Core, provider, credentials, microphone or network inference is used. CSP blocks all connections; the static server binds only to loopback. Writes are displayed in memory. Synthetic policy writes are rejected. The fixture is not part of the packaged app.

Use the repository's existing dependencies and built renderer CSS. From the repository root, choose a separate temporary output directory:

```powershell
node apps/desktop/scripts/fixtures/preferred-model/build.cjs <output-directory>
node apps/desktop/scripts/fixtures/preferred-model/serve.cjs <output-directory>
```

Open the printed loopback port in a browser. Stop this server after testing. No dependency installation is needed. Build or serve failures are test-setup failures, not product acceptance.

Run these cases through **Bevorzugtes Modell**, not the separate provider dropdown. Reset between cases using **Fixture zurücksetzen**. Record the visible Writes/Hinweise and source hashes.

1. Open the list. `one.gguf` is active and disabled. Select `two.gguf`, switch the test session to `other`, and confirm the price warning. Expect two POSTs (request and confirmation), then one `config.set` targeting **original**, never `other`. The notice must describe the earlier chat and state that local inference is unverified.
2. Select `two.gguf`, toggle the runtime fixture off while the price warning is open, then confirm. Expect the disabled-runtime message, only the initial POST and no `config.set`.
3. Enable **Antwort halten**, choose `two.gguf`. All model choices must be disabled and the pending one marked. Release the answer, then cancel the warning. Expect only the initial POST, no confirmation POST or chat write; the picker becomes usable again.
4. Filter by `Größe`, Tab from the input to the remaining model, press Enter. Expect the exact `org/Größe:Q4_K_M` in the POST; cancel without another write.
5. Open a price warning, change provider A→B→A using **Anbieter A/B wechseln**. The old warning must not reappear. A fresh choice may request a fresh warning.

These are reproducible manual browser regressions. Store/list assertions run automatically through the existing `model-provider.test.ts` and `ProviderRow.test.ts` entry points. This fixture does not establish Windows/Electron integration, native inference, acoustic behavior or release acceptance.
