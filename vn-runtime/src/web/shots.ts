/**
 * Visual-regression shot harness. Loads /shots/fixtures.json, renders every
 * fixture deterministically (instant transitions, seeded particles) through
 * the same PixiStage the client uses, and POSTs PNGs back to the dev server.
 */
import { PixiStage, type StageAction, type StageState } from "./stage.js";

interface Fixture {
  name: string;
  state: StageState & { fill: number | null };
  actions: StageAction[];
}

async function run(): Promise<void> {
  const out = document.getElementById("out")!;
  const parent = document.getElementById("pixi-parent")!;
  const stage = await PixiStage.create(parent);
  const fixtures = (await (await fetch("shots/fixtures.json")).json()) as Fixture[];
  const results: string[] = [];
  for (const f of fixtures) {
    stage.reset();
    await stage.apply(f.state, f.actions, (file) => `assets/${file}`, { instant: true });
    // two RAF ticks so texture uploads land before extraction
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const png = await stage.snapshotPng();
    const res = await fetch(`shots/save/${encodeURIComponent(f.name)}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: png,
    });
    results.push(`${f.name}: ${res.ok ? "saved" : "FAILED"}`);
    out.textContent = results.join("\n");
  }
  out.textContent = results.join("\n") + "\nDONE";
  document.title = "shots done";
}
void run();
