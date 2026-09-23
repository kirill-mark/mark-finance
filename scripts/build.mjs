// Сборка статического приложения в docs/ (GitHub Pages: ветка main, папка /docs).
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const out = "docs";
const watch = process.argv.includes("--watch");
let version = Date.now().toString(36);
try { version = execSync("git rev-parse --short HEAD").toString().trim() + "-" + version; } catch {}

// Публичные параметры Supabase (anon-ключ публичен по назначению, доступ закрыт RLS)
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://ofgicgqsmjvpsrvzefib.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mZ2ljZ3FzbWp2cHNydnplZmliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxODUyMTAsImV4cCI6MjEwMzc2MTIxMH0._N5Dpuz1ySkBwgypp8gSOPF7U3DnwV0XGIaPAGa3y34";

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/assets`, { recursive: true });
cpSync("public/icons", `${out}/icons`, { recursive: true });
cpSync("public/manifest.json", `${out}/manifest.json`);
for (const f of ["index.html", "sw.js"]) writeFileSync(`${out}/${f}`, readFileSync(`public/${f}`, "utf8").replaceAll("__VERSION__", version));
writeFileSync(`${out}/.nojekyll`, "");

const opts = {
  entryPoints: { app: "src/app/main.tsx" },
  outdir: `${out}/assets`,
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  jsx: "automatic",
  jsxImportSource: "preact",
  define: { __SUPABASE_URL__: JSON.stringify(SUPABASE_URL), __SUPABASE_ANON_KEY__: JSON.stringify(SUPABASE_ANON_KEY) },
  logLevel: "info",
};
if (watch) { const ctx = await context(opts); await ctx.watch(); }
else { await build(opts); console.log(`Собрано в ${out}/ (версия ${version})`); }
