import { SceneVm, type ChoiceDecision, type VmOptions } from "./vm.js";
import type { AssetIndex, ChoiceEvent, IrScene, PlayerEvent } from "./types.js";

export interface ScriptedRun {
  /** Answers for choices, in encounter order, or keyed by choice id. */
  choices?: number[];
  choiceById?: Record<number, number>;
  /** Stop after this many dialogue lines (0 = unlimited). */
  maxLines?: number;
}

export interface RunResult {
  events: PlayerEvent[];
  lines: number;
  choicesMade: { id: number | null; option: number; text: string; target: string | null }[];
  blockTrace: string[];
  end: Extract<PlayerEvent, { type: "end" }>;
  /** Assets actually requested during the run, in first-use order. */
  usedAssets: string[];
  /** Referenced assets that were absent from the manifest. */
  unresolved: string[];
}

/**
 * Drive a scene to completion with a scripted set of choice answers.
 * This is the headless "does the pipeline work" harness: it makes no
 * assumptions about which scene it is playing.
 */
export function runScene(
  scene: IrScene,
  assets: AssetIndex,
  script: ScriptedRun = {},
  vmOptions: VmOptions = {},
): RunResult {
  const vm = new SceneVm(scene, assets, vmOptions);
  const events: PlayerEvent[] = [];
  const choicesMade: RunResult["choicesMade"] = [];
  const usedAssets: string[] = [];
  const unresolved = new Set<string>();
  const seenAsset = new Set<string>();
  let lines = 0;
  let choiceIndex = 0;

  const noteAsset = (name: string | null, file: string | null): void => {
    if (!name || name === "<unresolved>") return;
    if (!seenAsset.has(name)) {
      seenAsset.add(name);
      usedAssets.push(name);
    }
    if (file === null) unresolved.add(name);
  };

  for (;;) {
    const ev = vm.next();
    events.push(ev);
    if (ev.type === "end") {
      return { events, lines, choicesMade, blockTrace: vm.blockTrace, end: ev, usedAssets, unresolved: [...unresolved] };
    }
    if (ev.type === "dialogue") {
      lines += 1;
      noteAsset(ev.voice, ev.voiceFile);
      if (ev.state.background) noteAsset(ev.state.background.asset, ev.state.background.file);
      for (const s of ev.state.sprites) noteAsset(s.asset, s.file);
      if (script.maxLines && lines >= script.maxLines) {
        return {
          events,
          lines,
          choicesMade,
          blockTrace: vm.blockTrace,
          end: { type: "end", reason: "stepLimit" },
          usedAssets,
          unresolved: [...unresolved],
        };
      }
      continue;
    }
    // choice
    const decision = pickChoice(ev, script, choiceIndex++);
    const opt = ev.options.find((o) => o.index === decision.option);
    choicesMade.push({
      id: ev.id,
      option: decision.option,
      text: opt?.text ?? "?",
      target: opt?.target ?? null,
    });
    vm.choose(ev, decision);
  }
}

function pickChoice(ev: ChoiceEvent, script: ScriptedRun, encounter: number): ChoiceDecision {
  if (ev.id != null && script.choiceById && ev.id in script.choiceById) {
    return { option: script.choiceById[ev.id]! };
  }
  const byOrder = script.choices?.[encounter];
  if (byOrder !== undefined) return { option: byOrder };
  return { option: ev.options[0]?.index ?? 0 };
}

export { SceneVm };
