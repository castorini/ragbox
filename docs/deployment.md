# RAGbox: Deployment

RAGbox builds to a static site. The host serves application assets and the prepared NFCorpus data; each visitor creates their own browser index and explicitly downloads the optional model or MS MARCO artifact.

## Build for a static host

Install dependencies and [prepare NFCorpus](installation.md#prepare-nfcorpus) before building:

```sh
npm ci
npm run prepare:nfcorpus -- /path/to/nfcorpus/corpus.jsonl
npm test
npm run build -- --base=/ragbox/
```

Publish the contents of `dist/` at the matching path. For a site served at the origin root, use:

```sh
npm run build -- --base=/
```

Vite can build without `public/data/nfcorpus.jsonl`, but NFCorpus setup will then fail in a fresh browser. Confirm that `dist/data/nfcorpus.jsonl` exists in an artifact that should support NFCorpus.

The site needs HTTPS outside a loopback development environment so that OPFS and WebGPU are available. Serve JavaScript modules and WebAssembly assets with appropriate content types. Document retrieval and inference execute in browser workers; deploying a search or model server is not part of this workflow.

## Preview the production path

After building with `--base=/ragbox/`, run the installed Vite preview server:

```sh
npm run preview
```

Open [http://127.0.0.1:4173/ragbox/](http://127.0.0.1:4173/ragbox/) and check Chat, Settings, collection preparation, and the model worker. Preview storage is separate from the development server on port `5173`.

Workers, dataset requests, navigation, and Settings links must work under the chosen base. The production-path checks in [the development guide](development.md#validation) complement a successful bundle build.

## Deploy with GitHub Pages

The existing [Pages workflow](../.github/workflows/pages.yml) runs on pushes to `main` and manual dispatch. It:

1. Uses Node.js 22 and installs the locked dependencies.
2. Runs the test suite.
3. Downloads the BEIR NFCorpus archive and runs the preparation script.
4. Configures Pages and builds with `npm run build -- --base=/ragbox/`.
5. Uploads `dist/` and deploys the Pages artifact.

In the repository's **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source. Push the intended changes to `main`, or run **Deploy demo to GitHub Pages** manually from Actions. The deployment job reports the published URL.

The current build path is explicitly `/ragbox/`. The workflow exports Pages metadata as `PAGES_BASE`, but the build command does not consume that variable. For a renamed repository, custom path, or origin-root deployment, update the command's `--base` to match the destination and repeat the production-path smoke check.

Generated NFCorpus data is included in the deployment artifact and stays ignored by Git. The workflow does not bundle the MS MARCO database or MiniCPM weights. Existing browser storage on localhost does not transfer to the published origin.

## Configure the MS MARCO download

The application has a pinned default public artifact URL. To override it for local development, create the ignored `.env.local` file:

```dotenv
VITE_MSMARCO_INDEX_URL=https://example.org/msmarco-prebuilt.duckdb
```

Replace the example with a direct database URL and restart the development server. For a production build, supply the same variable in the build environment:

```sh
VITE_MSMARCO_INDEX_URL=https://example.org/msmarco-prebuilt.duckdb \
  npm run build -- --base=/ragbox/
```

For the Pages workflow, set a repository Actions variable named **`MSMARCO_INDEX_URL`**. The workflow passes it as `VITE_MSMARCO_INDEX_URL` during the build. An unset or empty value uses the application's default URL. Vite embeds the chosen URL in public client code, so it must not contain credentials or secrets.

The URL override does not change the expected **3,346,542,592-byte** length in [src/services/msmarco.ts](../src/services/msmarco.ts). A different artifact requires updating that constant and size labels, plus preserving the table and FTS schema. See [collection compatibility](collections.md#host-a-compatible-artifact).

The downloader accepts HTTPS and loopback HTTP, rejects HTML responses, and verifies the exact streamed byte count before committing. A cross-origin host must permit browser fetches through CORS, including across redirects. These checks validate transfer completion and basic database compatibility; they are not a cryptographic integrity check.

## Runtime network and storage

A deployed application can request:

- Application assets and `data/nfcorpus.jsonl` from the static host.
- DuckDB workers and Wasm modules selected from its jsDelivr bundles.
- The matching DuckDB FTS extension assets.
- Model files from Hugging Face after an explicit download or repair action.
- The configured MS MARCO artifact after a confirmed download.

Account for those origins when configuring network restrictions or a Content Security Policy. The application also creates workers from blob URLs for DuckDB. Test actual runtime initialization under the host's policy; serving the HTML successfully does not establish worker, extension, or GPU readiness.

Retrieval and generation stay on the device, but startup is not guaranteed to work fully offline. Cached model files can be reused without automatically downloading missing model files. Browser eviction, quota limits, and origin changes still affect persistence; see [browser storage](storage.md).

[Documentation](README.md)
