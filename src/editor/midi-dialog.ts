import {
  formatTempoBpm,
  MusicCommon,
  quarterBpmFromUnit,
  tempoBpmForUnit,
  type TempoBeatUnit,
} from "../score/score";
import { detectMidiSlashGestures } from "../midi";
import type {
  MidiAnalysis,
  MidiHandMode,
  MidiImportOptions,
  MidiOutputFormat,
  MidiQuantizeDivision,
  MidiScoreMode,
  MidiSlashGroupMode,
  MidiSlashOrdering,
  MidiTrackAssignment,
  ParsedMidi,
} from "../midi";

interface InstrumentEditor {
  root: HTMLDivElement;
  name: HTMLInputElement;
  tracks: Map<number, { checked: HTMLInputElement; voice: HTMLSelectElement }>;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "modal-row";
  const text = document.createElement("span");
  text.textContent = label;
  el.append(text, control);
  return el;
}

function option(value: string, text: string, selected = false): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = text;
  el.selected = selected;
  return el;
}

function pitchName(pitch: number): string {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

function slashGroupSelect(value: MidiSlashGroupMode): HTMLSelectElement {
  const select = document.createElement("select");
  select.append(
    option("none", "留空（不使用此括号）", value === "none"),
    option("grace", "倚音（装饰音不占拍长）", value === "grace"),
    option("arpeggio", "琶音（三个及以上音的滚奏和弦）", value === "arpeggio"),
    option("triplet", "三连音（3:2 均分）", value === "triplet"),
    option("subdivide", "普通细分（最低时值÷2）", value === "subdivide"),
  );
  return select;
}

/** Analyze-first MIDI import dialog. Resolves null when cancelled. */
export function showMidiImportDialog(parsed: ParsedMidi, analysis: MidiAnalysis, fileName: string): Promise<MidiImportOptions | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box midi-import-box";
    const heading = document.createElement("div");
    heading.className = "modal-title";
    heading.textContent = "MIDI 导入";

    const info = document.createElement("div");
    info.className = "midi-import-info";
    const title = parsed.title || fileName.replace(/\.(?:mid|midi)$/i, "") || "未命名 MIDI";
    const bars = analysis.durationQuarterNotes / (analysis.beats * 4 / analysis.beatType);
    info.textContent = `${title} · ${parsed.trackCount} 轨 · ${analysis.noteCount} 音符 · 约 ${bars.toFixed(1)} 小节 · ` +
      `${analysis.beats}/${analysis.beatType} · ${analysis.tempoBpm} BPM`;

    const histogram = document.createElement("div");
    histogram.className = "midi-duration-counts";
    histogram.textContent = ([4, 8, 16, 32, 64] as MidiQuantizeDivision[])
      .map((d) => `${d}分：${analysis.durationCounts[d]}`)
      .join("　") + `　三连音音符：${analysis.tripletNoteCount}` +
      `　疑似倚音组：${analysis.graceGroupCount}　上行琶音组：${analysis.arpeggioGroupCount}`;

    const warning = document.createElement("div");
    warning.className = "midi-import-warning";
    if (analysis.suspectedGraceDivision !== null) {
      warning.textContent = `⚠ 疑似倚音：${analysis.suspectedGraceCount} 个 ${analysis.suspectedGraceDivision} 分音符；该档未参与推荐量化，音符仍会保留。`;
    } else {
      warning.hidden = true;
    }

    const quantize = document.createElement("select");
    for (const d of [4, 8, 16, 32, 64] as MidiQuantizeDivision[]) {
      quantize.append(option(String(d), `${d} 分音符${d === analysis.recommendedQuantize ? "（推荐）" : ""}`, d === analysis.recommendedQuantize));
    }
    const outputFormat = document.createElement("select");
    outputFormat.append(
      option("jpw", "JPW 简谱（完整排版）", true),
      option("keyboard", "键盘谱文本（完整排版）"),
      option("number", "数字谱文本（完整排版）"),
    );
    const slashOrdering = document.createElement("select");
    slashOrdering.append(
      option("pitch-asc", "音高正序（低音到高音）", true),
      option("pitch-desc", "音高逆序（高音到低音）"),
      option("voice-asc", "声部正序（V1 到 VN）"),
      option("voice-desc", "声部逆序（VN 到 V1）"),
    );
    const braceMode = slashGroupSelect(analysis.arpeggioGroupCount > 0 ? "arpeggio" : "grace");
    const bracketMode = slashGroupSelect("triplet");
    const liveGestureCounts = document.createElement("div");
    liveGestureCounts.className = "midi-live-gesture-counts";
    let autoBraceMode = true;
    braceMode.addEventListener("change", () => { autoBraceMode = false; });
    const slashGroups = document.createElement("details");
    slashGroups.className = "midi-slash-groups";
    slashGroups.open = analysis.graceGroupCount > 0 || analysis.arpeggioGroupCount > 0 || analysis.tripletNoteCount > 0;
    const slashGroupSummary = document.createElement("summary");
    slashGroupSummary.textContent = "键盘谱 / 数字谱括号用途";
    const slashGroupHint = document.createElement("div");
    slashGroupHint.className = "modal-hint";
    slashGroupHint.textContent = "仅用于文本谱输出。系统先识别倚音、三连音与同一量化格内的上行滚奏和弦，再按这里选择的括号写出；选择“留空”就不为该括号分配功能，未分配的类型仍作为普通音符保留。";
    slashGroups.append(
      slashGroupSummary,
      slashGroupHint,
      row("花括号 {}", braceMode),
      row("方括号 []", bracketMode),
    );
    const updateGestureAnalysis = (): void => {
      const division = parseInt(quantize.value, 10) as MidiQuantizeDivision;
      const gestures = detectMidiSlashGestures(parsed, division);
      liveGestureCounts.textContent =
        `当前 ${division} 分量化重新识别：倚音 ${gestures.grace.length} 组，` +
        `琶音 ${gestures.arpeggio.length} 组，三连音 ${gestures.triplet.length} 组`;
      if (autoBraceMode) {
        braceMode.value = gestures.arpeggio.length > 0 ? "arpeggio" : "grace";
      }
      slashGroups.open = slashGroups.open ||
        gestures.grace.length > 0 ||
        gestures.arpeggio.length > 0 ||
        gestures.triplet.length > 0;
    };
    quantize.addEventListener("change", updateGestureAnalysis);

    const triplets = document.createElement("input");
    triplets.type = "checkbox";
    triplets.checked = true;
    const hands = document.createElement("select");
    hands.append(
      option("auto", `自动（建议${analysis.autoHandMode === "double" ? "双手" : "单手"}）`, true),
      option("single", "单手 .Voice"),
      option("double", "双手 .Voice.RH / .Voice.LH"),
    );
    const split = document.createElement("input");
    split.type = "number";
    split.min = "48";
    split.max = "72";
    split.value = String(analysis.splitPitch);
    const splitWrap = document.createElement("span");
    splitWrap.className = "midi-split-control";
    const splitName = document.createElement("em");
    splitName.textContent = pitchName(analysis.splitPitch);
    split.oninput = () => { splitName.textContent = pitchName(parseInt(split.value, 10) || 60); };
    splitWrap.append(split, splitName);

    const soundingTracks = parsed.tracks.filter((track) => track.noteCount > 0);
    const handTrackName = /(?:\brh\b|\blh\b|right|left|右手|左手)/i;
    const looksLikeNamedPiano = soundingTracks.length === 2 && soundingTracks.every((track) => handTrackName.test(track.name));
    const scoreMode = document.createElement("select");
    scoreMode.append(option("hands", "智能单谱行 / 钢琴双手", looksLikeNamedPiano || soundingTracks.length < 3));
    if (soundingTracks.length >= 3) {
      scoreMode.append(option("ensemble", "多轨总谱（按乐器与声部）", !looksLikeNamedPiano));
    }

    const mapping = document.createElement("details");
    mapping.className = "midi-track-mapping";
    mapping.open = true;
    const mappingSummary = document.createElement("summary");
    mappingSummary.textContent = "轨道、乐器与声部";
    const mappingHint = document.createElement("div");
    mappingHint.className = "modal-hint";
    mappingHint.textContent = "每条含音符轨道只能分配给一个乐器。一个乐器勾选多条轨道时，可指定声部顺序；声部 1 位于最上方。";
    const mappingList = document.createElement("div");
    mappingList.className = "midi-instrument-list";
    const editors: InstrumentEditor[] = [];

    const refreshEditor = (editor: InstrumentEditor): void => {
      const selected = soundingTracks
        .map((track) => ({ track, control: editor.tracks.get(track.index)! }))
        .filter((item) => item.control.checked.checked);
      selected.forEach((item, index) => {
        item.control.voice.disabled = selected.length <= 1;
        if (selected.length <= 1) item.control.voice.value = "1";
        else if (!item.control.voice.value) item.control.voice.value = String(index + 1);
      });
      for (const control of editor.tracks.values()) {
        if (!control.checked.checked) control.voice.disabled = true;
      }
    };

    const addInstrumentEditor = (suggestedName: string, selectedTrackIds: number[] = []): InstrumentEditor => {
      const root = document.createElement("div");
      root.className = "midi-instrument-editor";
      const header = document.createElement("div");
      header.className = "midi-instrument-header";
      const name = document.createElement("input");
      name.type = "text";
      name.placeholder = "乐器名称";
      name.value = suggestedName;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除乐器";
      header.append(name, remove);
      root.append(header);
      const editor: InstrumentEditor = { root, name, tracks: new Map() };
      for (const track of soundingTracks) {
        const trackRow = document.createElement("label");
        trackRow.className = "midi-track-row";
        const checked = document.createElement("input");
        checked.type = "checkbox";
        checked.checked = selectedTrackIds.includes(track.index);
        const label = document.createElement("span");
        label.textContent = `轨道 ${track.index + 1} · ${track.name || "未命名"} · ${track.noteCount} 音符`;
        const voice = document.createElement("select");
        voice.title = "该轨道在乐器组中的上下顺序";
        for (let index = 1; index <= soundingTracks.length; index++) {
          voice.append(option(String(index), `声部 ${index}`, index === selectedTrackIds.indexOf(track.index) + 1));
        }
        editor.tracks.set(track.index, { checked, voice });
        checked.onchange = () => {
          if (checked.checked) {
            for (const other of editors) {
              if (other === editor) continue;
              const sameTrack = other.tracks.get(track.index);
              if (sameTrack?.checked.checked) {
                sameTrack.checked.checked = false;
                refreshEditor(other);
              }
            }
            const selectedCount = [...editor.tracks.values()].filter((item) => item.checked.checked).length;
            voice.value = String(selectedCount);
          }
          refreshEditor(editor);
        };
        trackRow.append(checked, label, voice);
        root.append(trackRow);
      }
      remove.onclick = () => {
        const index = editors.indexOf(editor);
        if (index >= 0) editors.splice(index, 1);
        root.remove();
      };
      editors.push(editor);
      mappingList.append(root);
      refreshEditor(editor);
      return editor;
    };

    const handNamedTracks = soundingTracks.filter((track) => handTrackName.test(track.name));
    if (handNamedTracks.length >= 2) {
      const orderedHands = [...handNamedTracks].sort((a, b) =>
        Number(/(?:\blh\b|left|左手)/i.test(a.name)) - Number(/(?:\blh\b|left|左手)/i.test(b.name)),
      );
      addInstrumentEditor("钢琴", orderedHands.map((track) => track.index));
      for (const track of soundingTracks) {
        if (!handNamedTracks.includes(track)) addInstrumentEditor(track.name.trim() || `乐器 ${editors.length + 1}`, [track.index]);
      }
    } else {
      soundingTracks.forEach((track, index) => addInstrumentEditor(track.name.trim() || `乐器 ${index + 1}`, [track.index]));
    }
    const addInstrument = document.createElement("button");
    addInstrument.type = "button";
    addInstrument.className = "midi-add-instrument";
    addInstrument.textContent = "＋ 添加乐器";
    addInstrument.onclick = () => addInstrumentEditor(`乐器 ${editors.length + 1}`);
    mapping.append(mappingSummary, mappingHint, mappingList, addInstrument);

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = title;
    const subtitle = document.createElement("input");
    subtitle.type = "text";
    subtitle.placeholder = "可留空";
    const composer = document.createElement("input");
    composer.type = "text";
    composer.placeholder = "可留空";
    const arranger = document.createElement("input");
    arranger.type = "text";
    arranger.placeholder = "可留空";
    const lyricist = document.createElement("input");
    lyricist.type = "text";
    lyricist.placeholder = "可留空";
    const instrumentName = document.createElement("input");
    instrumentName.type = "text";
    instrumentName.value = "钢琴";

    const key = document.createElement("select");
    for (let fifths = -7; fifths <= 7; fifths++) {
      key.append(option(String(fifths), `1=${MusicCommon.keys[fifths + 7]}`, fifths === analysis.fifths));
    }
    const beats = document.createElement("input");
    beats.type = "number";
    beats.min = "1";
    beats.max = "32";
    beats.value = String(analysis.beats);
    const beatType = document.createElement("select");
    for (const d of [2, 4, 8, 16]) beatType.append(option(String(d), String(d), d === analysis.beatType));
    const meter = document.createElement("span");
    meter.className = "midi-meter-control";
    meter.append(beats, document.createTextNode(" / "), beatType);
    const tempo = document.createElement("input");
    tempo.type = "number";
    tempo.min = "0.1";
    tempo.max = "1998";
    tempo.step = "0.1";
    const tempoUnit = document.createElement("select");
    tempoUnit.append(
      option("dotted-quarter", "附点四分音符"),
      option("eighth", "八分音符"),
    );
    const tempoUnitRow = row("速度音符", tempoUnit);
    let displayedTempoUnit: TempoBeatUnit = "quarter";
    let quarterTempo = analysis.tempoBpm;
    tempo.value = formatTempoBpm(quarterTempo);
    const setDisplayedTempoUnit = (unit: TempoBeatUnit): void => {
      const entered = parseFloat(tempo.value);
      if (Number.isFinite(entered)) {
        quarterTempo = quarterBpmFromUnit(entered, displayedTempoUnit);
      }
      displayedTempoUnit = unit;
      tempo.value = formatTempoBpm(tempoBpmForUnit(quarterTempo, unit));
      if (unit !== "quarter") tempoUnit.value = unit;
    };
    const updateTempoUnit = (): void => {
      const isEighthMeter = parseInt(beatType.value, 10) === 8;
      tempoUnitRow.hidden = !isEighthMeter;
      tempoUnitRow.style.display = isEighthMeter ? "" : "none";
      if (isEighthMeter) {
        const count = parseInt(beats.value, 10) || 0;
        setDisplayedTempoUnit(count >= 6 && count % 3 === 0
          ? "dotted-quarter"
          : "eighth");
      } else {
        setDisplayedTempoUnit("quarter");
      }
    };
    tempo.addEventListener("input", () => {
      const entered = parseFloat(tempo.value);
      if (Number.isFinite(entered)) {
        quarterTempo = quarterBpmFromUnit(entered, displayedTempoUnit);
      }
    });
    tempoUnit.addEventListener("change", () => {
      setDisplayedTempoUnit(tempoUnit.value as TempoBeatUnit);
    });
    beatType.addEventListener("change", updateTempoUnit);
    beats.addEventListener("change", updateTempoUnit);

    const controls = document.createElement("div");
    const handRow = row("钢琴手部", hands);
    const splitRow = row("双手分割音高", splitWrap);
    const orderingRow = row("文本谱和弦书写顺序", slashOrdering);
    controls.append(
      row("导入后格式", outputFormat),
      row("谱面结构", scoreMode),
      row("推荐量化", quantize),
      row("自动识别三连音", triplets),
      orderingRow,
      handRow,
      splitRow,
    );
    const metadata = document.createElement("details");
    metadata.open = true;
    const metadataSummary = document.createElement("summary");
    metadataSummary.textContent = "标题与署名（可选）";
    const instrumentRow = row("钢琴乐器名称", instrumentName);
    metadata.append(
      metadataSummary,
      row("标题", titleInput),
      row("副标题", subtitle),
      row("作曲", composer),
      row("编曲", arranger),
      row("作词", lyricist),
      instrumentRow,
    );
    const advanced = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "调号、拍号与速度";
    advanced.append(
      summary,
      row("调号", key),
      row("拍号", meter),
      tempoUnitRow,
      row("速度（BPM）", tempo),
    );

    const hint = document.createElement("div");
    hint.className = "modal-hint";
    const updateHint = () => {
      hint.textContent = outputFormat.value === "jpw"
        ? scoreMode.value === "ensemble"
          ? "每条已分配轨道会生成独立声部；同一乐器的声部从上到下排列，所有乐器共享小节与节奏横坐标。"
          : "音头和音尾都会吸附到网格；同拍音组成纵向和弦。独立重叠声部会化简为每只手一条可编辑简谱线。"
        : "键盘谱/数字谱会保留当前手部或轨道分配：单声部仍为单谱表，双手及多轨会写入隐形声部标记并生成完整的上下多声部排版。";
    };
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.textContent = "导入并转为简谱";
    footer.append(cancel, confirm);
    box.append(heading, info, histogram, liveGestureCounts, warning, controls, slashGroups, mapping, metadata, advanced, hint, footer);
    overlay.append(box);
    document.body.append(overlay);

    const close = (value: MidiImportOptions | null) => { overlay.remove(); resolve(value); };
    cancel.onclick = () => close(null);
    overlay.onclick = (event) => { if (event.target === overlay) close(null); };
    const updateStructure = (): void => {
      const ensemble = scoreMode.value === "ensemble";
      mapping.hidden = !ensemble;
      handRow.hidden = ensemble;
      splitRow.hidden = ensemble;
      instrumentRow.hidden = ensemble;
      slashGroups.hidden = outputFormat.value === "jpw";
      orderingRow.hidden = false;
      mapping.style.display = ensemble ? "" : "none";
      handRow.style.display = ensemble ? "none" : "";
      splitRow.style.display = ensemble ? "none" : "";
      instrumentRow.style.display = ensemble ? "none" : "";
      slashOrdering.disabled = outputFormat.value === "jpw";
      orderingRow.style.opacity = outputFormat.value === "jpw" ? "0.5" : "1";
      orderingRow.title = outputFormat.value === "jpw"
        ? "切换为键盘谱或数字谱后可设置四种和弦书写顺序"
        : "";
      if (!ensemble) splitRow.style.opacity = hands.value === "single" ? "0.45" : "1";
      updateHint();
    };
    const collectTrackAssignments = (): MidiTrackAssignment[] => {
      const result: MidiTrackAssignment[] = [];
      for (let editorIndex = 0; editorIndex < editors.length; editorIndex++) {
        const editor = editors[editorIndex];
        const instrument = editor.name.value.trim() || `乐器 ${editorIndex + 1}`;
        const selected = soundingTracks
          .map((track) => ({ track, control: editor.tracks.get(track.index)! }))
          .filter((item) => item.control.checked.checked)
          .sort((a, b) =>
            parseInt(a.control.voice.value, 10) - parseInt(b.control.voice.value, 10) ||
            a.track.index - b.track.index,
          );
        selected.forEach((item, index) => result.push({
          track: item.track.index,
          instrumentName: instrument,
          voice: index + 1,
        }));
      }
      return result;
    };
    hands.onchange = updateStructure;
    scoreMode.onchange = updateStructure;
    outputFormat.onchange = () => {
      updateStructure();
      updateHint();
    };
    confirm.onclick = () => {
      const trackAssignments = collectTrackAssignments();
      if (scoreMode.value === "ensemble" && trackAssignments.length === 0) {
        mapping.open = true;
        mappingHint.textContent = "请至少为一个乐器勾选一条含音符的轨道。";
        mappingHint.classList.add("midi-mapping-error");
        return;
      }
      close({
        quantize: parseInt(quantize.value, 10) as MidiQuantizeDivision,
        detectTriplets: triplets.checked,
        handMode: hands.value as MidiHandMode,
        splitPitch: clampPitch(parseInt(split.value, 10)),
        fifths: parseInt(key.value, 10),
        beats: Math.max(1, Math.min(32, parseInt(beats.value, 10) || 4)),
        beatType: parseInt(beatType.value, 10),
        tempoBpm: Math.max(
          0.1,
          Math.min(
            999,
            Math.round(quarterBpmFromUnit(
              parseFloat(tempo.value) || tempoBpmForUnit(analysis.tempoBpm, displayedTempoUnit),
              displayedTempoUnit,
            ) * 10) / 10,
          ),
        ),
        tempoBeatUnit: displayedTempoUnit,
        title: titleInput.value.trim(),
        subtitle: subtitle.value.trim(),
        composer: composer.value.trim(),
        arranger: arranger.value.trim(),
        lyricist: lyricist.value.trim(),
        instrumentName: instrumentName.value.trim(),
        scoreMode: scoreMode.value as MidiScoreMode,
        trackAssignments,
        outputFormat: outputFormat.value as MidiOutputFormat,
        slashBraceMode: braceMode.value as MidiSlashGroupMode,
        slashBracketMode: bracketMode.value as MidiSlashGroupMode,
        slashOrdering: slashOrdering.value as MidiSlashOrdering,
      });
    };
    updateTempoUnit();
    updateStructure();
    updateGestureAnalysis();
    quantize.focus();
  });
}

function clampPitch(pitch: number): number {
  return Math.max(48, Math.min(72, Number.isFinite(pitch) ? pitch : 60));
}
