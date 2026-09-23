import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";

// maplibre-gl-worker.mjs (loaded via a `?url` import so Vite emits it as a
// standalone worker script) contains its own hardcoded relative import of
// "./maplibre-gl-shared.mjs" - a sibling chunk maplibre-gl ships next to the
// worker in its own package. Vite's `?url` handling copies only the worker
// file itself into dist/assets (hashed), never following that internal
// relative import, so the sibling chunk is silently missing from the build
// and the worker fails to load at runtime. Copy it in ourselves, unhashed,
// so the worker's relative import resolves.
function copyMaplibreWorkerSharedChunk(): Plugin {
  const sourceFile = path.resolve(
    __dirname,
    "node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs"
  );
  return {
    name: "copy-maplibre-gl-worker-shared-chunk",
    apply: "build",
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist/assets");
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(sourceFile, path.join(outDir, "maplibre-gl-shared.mjs"));
    },
  };
}

// Project refs are the subdomain in each Supabase project's URL - not
// secrets (they're visible in every request the browser makes), so
// logging/comparing them here is safe. Used only to make the resolved
// environment unambiguous and to guard against production leaking into
// a non-production mode - never to gate anything security-relevant
// (that's RLS/grants' job, not this file's).
const PRODUCTION_PROJECT_REF = "kjsseqlmnmiuqepfmldh";
const STAGING_PROJECT_REF = "wemjskpbulebxgyhyhmk";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const supabaseUrl = env.VITE_SUPABASE_URL ?? "";
  const isProduction = supabaseUrl.includes(PRODUCTION_PROJECT_REF);
  const isStaging = supabaseUrl.includes(STAGING_PROJECT_REF);
  const projectRef = supabaseUrl.replace(/^https?:\/\//, "").split(".")[0] || "(unset)";

  // The normal dev command (mode="development", from plain `npm run dev`)
  // must never resolve to production - only an explicit production mode
  // (`npm run build`'s default mode, or `npm run dev:production`) may.
  // This is a hard stop, not just a log: it's what actually prevents the
  // "npm run dev silently talks to production" incident from recurring,
  // even if some future .env/.env.local edit reintroduces prod values
  // into a non-production file.
  if (isProduction && mode !== "production") {
    throw new Error(
      `[env-guard] Refusing to start: resolved Supabase project is PRODUCTION (${projectRef}) ` +
      `but Vite mode is "${mode}", not "production". This almost always means a .env/.env.local ` +
      `file has production values where staging is expected. Use "npm run dev" for staging, or ` +
      `"npm run dev:production" only when you deliberately mean to target production.`
    );
  }

  const label = isProduction ? "PRODUCTION" : isStaging ? "STAGING" : "UNKNOWN";
  console.log(`\n[env-guard] mode="${mode}" -> Supabase target: ${label} (${projectRef})\n`);

  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [react(), copyMaplibreWorkerSharedChunk()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
