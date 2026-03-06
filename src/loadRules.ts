import { readFileSync } from "node:fs";
import { RulesPackage } from "./models.js";

export function loadRulesFromFile(filePath: string): RulesPackage {
  const raw = readFileSync(filePath, { encoding: "utf8" });
  return JSON.parse(raw) as RulesPackage;
}
