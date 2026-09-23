// Собирает supabase/install.sql — один файл для вставки в Supabase → SQL Editor.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = "supabase/migrations";
const parts = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => `-- ===== ${f} =====\n` + readFileSync(`${dir}/${f}`, "utf8"));
parts.push("-- ===== owner.sql =====\n" + readFileSync("supabase/owner.sql", "utf8"));
writeFileSync("supabase/install.sql", "-- Mark Finance · установка схемы. Повторный запуск безопасен.\n\n" + parts.join("\n\n"));
console.log("supabase/install.sql собран");
