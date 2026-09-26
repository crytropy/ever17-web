/**
 * Entry point for the standalone `/records` page.
 *
 * The rendering and the disclosure rules live in `records.ts`, which the game
 * itself imports to draw the same screen as an in-game overlay. That module
 * must therefore stay free of side effects: booting a page from it would run
 * this bootstrap inside the game bundle too, looking for elements that only
 * exist here.
 */
import { labelForScene, type GamePackageMeta, type NarrativeProgressCatalog } from "kid-contracts";
import { CompletionTracker, IdbCompletionStore } from "./completion.js";
import { readActiveScope } from "./play-data.js";
import { renderRecordsInto } from "./records.js";
import { SaveSlots } from "./slots.js";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

async function main(): Promise<void> {
  const meta = await fetch("game.json")
    .then((r) => (r.ok ? (r.json() as Promise<GamePackageMeta>) : null))
    .catch(() => null);
  const catalog = await fetch("narrative.json")
    .then((r) => (r.ok ? (r.json() as Promise<NarrativeProgressCatalog>) : null))
    .catch(() => null);

  if (meta?.branding?.title) {
    document.title = `${meta.branding.title} · records`;
  }

  const ns = meta?.profile.storageNamespace ?? "kidvn";
  const scope = readActiveScope(localStorage, ns);
  const tracker = await CompletionTracker.open(new IdbCompletionStore(scope.completionDb)).catch(() => null);
const visited = new Set(tracker?.scenes ?? []);
const collected = new Set(tracker?.endings ?? []);
const discoveredAssets = new Set(tracker?.assets ?? []);

  // "last played" comes from the newest save, so it survives a reload
  try {
    const slots = new SaveSlots(localStorage, scope.storagePrefix);
    const list = slots.list();
    const latest = list.length > 0 ? list.reduce((a, b) => (b.savedAt > a.savedAt ? b : a)) : null;
    if (latest && catalog) {
      $("lede").textContent = `最后游玩 · ${labelForScene(catalog, latest.scene).shortLabel}`;
    }
  } catch {
    /* storage unavailable: the rest of the page still renders */
  }

  renderRecordsInto(
  $("content"),
  catalog,
  visited,
  collected,
  discoveredAssets,
);
}

void main();
