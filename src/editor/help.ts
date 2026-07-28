// 帮助对话框：双标签页（功能帮助 + 记谱法）。只读，自建 overlay（参照 export.ts 的
// showExportDialog），复用 .modal-overlay/.modal-box 样式 + 本文件专属的 .help-* 样式。
// 功能帮助 = 可展开主题列表（<details>）；记谱法 = 分节说明 + 实时渲染的 SVG 示例。
import type { App } from "./app";

// ---- 小工具 ----------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 内联富文本：把 `**粗**`、`` `代码` `` 转成 span，避免手搓一堆 createElement。 */
function rich(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) frag.append(el("strong", undefined, m[1]));
    else if (m[2] != null) frag.append(el("code", "help-code", m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function para(text: string, cls = "help-p"): HTMLParagraphElement {
  const p = el("p", cls);
  p.append(rich(text));
  return p;
}

// ---- 功能帮助 --------------------------------------------------------------

type Badge = "desktop" | "browser" | "mac";
const BADGE_TEXT: Record<Badge, string> = {
  desktop: "🖥 仅桌面版",
  browser: "🌐 仅浏览器",
  mac: "🍎 仅 macOS 桌面",
};

interface Topic {
  title: string;
  badges?: Badge[];
  /** 段落文本（支持 **粗** 与 `代码`）。 */
  body: string[];
  /** 可选：额外自定义节点（如快捷键表）。 */
  extra?: () => HTMLElement;
}

const FEATURE_TOPICS: Topic[] = [
  {
    title: "打开与保存文件",
    body: [
      "左上角 **创建** 可新建 JPW 简谱、键盘谱或数字谱。工具栏 **打开** 支持 `.jpwabc`、键盘谱/数字谱 `.txt`、`.mid` / `.midi`、`.xml` / `.musicxml`、`.abc`；也可把这些文件拖到编辑器的任意区域直接导入。图片和 PDF 同样可拖入并进入本地识谱。",
      "**保存** / **另存为** 会按当前编辑格式保存：JPW 谱保存为 UTF-16LE `.jpwabc`，键盘谱和数字谱原文保存为 UTF-8 `.txt`。首次“保存”会询问位置并建立固定目标，之后直接写入；“另存为”只写副本，不改变正常保存目标。",
      "**桌面版**使用系统原生文件对话框；首次保存会默认定位到导入文件所在目录。支持 File System Access API 的浏览器也会保留本次任务的写入句柄；不支持的浏览器则退回下载。",
    ],
  },
  {
    title: "编辑与实时排版",
    body: [
      "左侧是谱子代码编辑区，支持 `.jpwabc`、键盘谱和数字谱原文，**边打字边重排**——停顿约 0.2 秒后右侧谱面自动更新。",
      "**谱面选音**：单击简谱音符会同时高亮谱面数字和左侧 `.Voice` 中对应文字；按 Ctrl/Cmd 点击可非连续多选，按 Shift 点击可连续多选，也可按住鼠标拖过多个音符。反过来，在 JPW、键盘谱或数字谱源码里选择文字，也会高亮对应谱面音符。Ctrl/Cmd 点击空白不会清掉已有多选，只有再次点击已选音符才会移除它。",
      "主音和左上角的倚音都可直接选中：谱面与源码会双向高亮。选中后按 1–7 直接改音高，按 ↑ / ↓ 增减上加点或下加点；按 Del / 退格把音符或速度标记软删除为半透明，双击可恢复。谱面获得焦点时也可按 Ctrl/Cmd+Z 撤回删除或音高编辑。",
      "选中音符后按 ← / →，会按工具栏“刻度”当前选择把起音向前或向后移动一格；未选择任何固定档位时自动采用当前节奏的最短网格。JPW 简谱还可按 Ctrl/Cmd+← / → 缩短或延长一格，必要时自动拆成跨小节延音；键盘谱和数字谱只移动位置，不用快捷键改写原始时值符号。以上操作都会写回当前谱子，并可用 Ctrl/Cmd+Z 撤回。",
      "混排、识别模式下代码区只读或隐藏（详见对应主题）。",
    ],
  },
  {
    title: "翻页与缩放",
    body: [
      "**翻页**：工具栏 上一页 / 下一页，或键盘 `PageUp` / `PageDown`；`Ctrl/⌘+Home` 跳首页、`Ctrl/⌘+End` 跳末页。",
      "**缩放**：工具栏 `−` / `100%` / `＋`，或 `Ctrl/⌘ +` / `-` / `0`，或按住 `Ctrl/⌘` 滚滚轮。",
      "**macOS 桌面版**还支持触控板双指捏合缩放。",
    ],
  },
  {
    title: "识图（图片转简谱）",
    body: [
      "把简谱**图片**（PNG/JPG 等）或 PDF 拖进编辑器任意区域，会自动识别成简谱并载入编辑。识别在**本地离线**完成，浏览器版和桌面版都能用。",
      "识别完成后，工具栏 **识别** 按钮可切换到「二值图 + 半透明识别结果叠加」的核对视图，配合右侧下拉选择 附近浮窗 / 原位叠加 / 仅原图 三种视图，点识别对象可定位到对应代码。",
      "识别结果建议再人工校对——尤其是歌词和复杂节奏。",
    ],
  },
  {
    title: "导入 ABC / MusicXML",
    body: [
      "**ABC 记谱**（`.abc`）：拖入或打开后自动转成简谱排版，支持多声部、反复、一二房、和弦、装饰音、歌词等。",
      "**MusicXML**（`.xml` / `.musicxml`）：标准钢琴双谱表会自动转换成可编辑的**右手/左手双行简谱**；其他多声部（如四部合唱）自动进入混排模式（五线谱 + 简谱）。",
    ],
  },
  {
    title: "导入 MIDI 与智能量化",
    body: [
      "打开或拖入 `.mid` / `.midi` 后，会先显示音符时值统计和 **4 / 8 / 16 / 32 / 64 分音符推荐量化**；音头和音尾会分别吸附到最终选择的最近网格。纵向和弦采用共同尾部后会再次吸附，跨小节长音则在小节线两侧拆成相邻延音链，续音不会重新发声。",
      "MIDI 内嵌标题和轨道名兼容 UTF-8、GBK / GB18030、Big5、Shift-JIS 及带 BOM 的 UTF-16；若文件本身只存了连续方框占位符，会自动改用不含路径与扩展名的真实文件名，避免导入对话框先显示方框。",
      "连续三个起音接近三连音网格时会自动写成 `{(3}… )`。推荐量化只采纳数量严格超过有效音符总数 2% 的时值档位；占比不超过 2% 的零星细音仍会保留，但不决定推荐档位。若最细时值同时不超过 3 个，则另外标成 **疑似倚音**。",
      "MIDI 中由多个速度事件组成的直线或曲线渐快会标为 `accel.`，渐慢会标为 `rit.`；标记放在离开前一段固定 BPM 的第一个实际变化事件，不会误放到谱首第一拍。速度重新稳定时写出 `♩=最终速度`。单行谱放在谱行上方，钢琴双行的渐快/渐慢放在两手之间，多声部与总谱只在整个系统顶部显示一次。",
      "拍号分母为 8 时，导入框会出现“速度音符”，可选择附点四分音符或八分音符。显示 BPM 从 MIDI 的四分音符 BPM 自动换算并最多保留一位小数；内部播放与 MIDI 导出仍保存等价的四分音符速度，避免重复换算。",
      "软件优先按轨道名和轨道音域判断单手/双手；也可手动选择并修改中央 C 附近的分割音高。双手导入后生成 `.Voice.RH` / `.Voice.LH`。",
      "“导入后格式”可选择 JPW、键盘谱文本或数字谱文本。后两种同样保留当前手部或轨道分配：单声部仍为单谱表，双手及多轨会写入 U+2063 隐形声部标记并生成完整上下多声部排版，同时在左侧保留可编辑的斜杠谱原文。",
      "输出键盘谱或数字谱时不会照搬 MIDI Note Off 或踏板形成的延音尾部，而是按文本谱的默认规则让每个起音延续到下一起音，再写出相邻时值符号。花括号与方括号可分别分配为倚音、琶音、三连音或普通细分；方括号默认三连音，检测到上行滚奏和弦时花括号默认琶音。",
      "琶音候选必须在同轨同通道内包含至少三个严格上行音，落在同一量化格、起音间隔很短且多数音彼此重叠，因此普通快速音阶不会被误折叠。`{A}(BC)` 表示 A 是不占小节拍长的前置倚音，`{ABC}` 可表示完整琶音；部分琶音统一把括号写在同时发声的主音前，例如 `{,NZCB}A`。括号内外会组成一个和弦，共用时值、延音和选择高亮，波浪线只覆盖括号内音。未分配到括号的检测类型仍保留为普通音符。成品谱会把倚音放在主音左上角并画两条十六分减时线，再用一条两端留白的小弧线指向主音；纵向和弦的琶音波浪线会按最高、最低音自动伸缩。",
      "每只手最终是一条可编辑简谱线：同拍音合成纵向和弦，独立重叠长音会截齐到下一起音并在导入摘要中报告。踏板、力度与弯音暂不进入简谱；后续速度变化会保留为上述可编辑排版标记。",
    ],
  },
  {
    title: "键盘谱 / 数字斜杠谱 TXT",
    body: [
      "键盘谱使用 `A–Z` 键位，数字谱使用 `1–7`，`+` / `-` 表示高低八度；`(AB)` 或 `(-47)` 表示同时按下的纵向和弦。默认是单谱行，也可在选项中启用 2–9 个同步声部。",
      "每个 `/` 是一个拍组，通常每行是一小节。没有小节换行时，导入框会要求填写拍号，再按拍号和当前时值符号自动切分连续拍组；`[line45]`、`[end48]` 等标签会忽略。",
      "导入时可配置任意数量的时值符号，例如点号=16分、等号=8分、星号=32分；符号留空表示不使用。同一符号重复出现会累加到相邻音符的时值，没有明确休止符时不会单独产生休止。“音符自身时值”可选留空或4/8/16/32/64分：设置后每个单音、每个括号和弦先具有一次所选基础时值，括号内有多少个键都仍算一个同时发声的和弦。",
      "空格有独立的4/8/16/32/64分选项：设置后，行首空格并入第一个音，音符之间和行尾空格并入前一个音；留空时才只是排版。比如音符自身=四分、空格=四分时，` (ZSGW)(BM) ` 会得到“ZSGW二分和弦、BM二分和弦”，不会在前后生成休止。",
      "确认导入后，软件会加入一行 `// @jpeditor {\"v\":2,\"vc\":N,…}` 设置注释，用来保存声部数量、拍号、速度与符号映射；保存并再次打开 TXT 时会恢复这些选择。",
      "导入或创建键盘谱/数字谱后，可随时点击顶部 **乐谱设置**，重新修改谱型识别、声部数量、乐器名称、速度、调号、拍号、时值符号、音符/空格时值、花括号/方括号功能和标题署名；应用后会立即重解析当前文本并更新谱面与播放。",
      "多声部使用音符前的 `U+2063 INVISIBLE SEPARATOR` 数量编码：一个为 V1、两个为 V2，以此类推；没有标记的音属于最后一个默认声部 VN。`Alt+1`–`Alt+9` 可给文本或谱面中选中的单音/和弦音分配声部；再次按同一非默认声部快捷键会移回默认声部。单声部第一次按 `Alt+1` 会自动建立上下双行谱。",
      "各声部共享起音时间轴和小节横坐标，但会独立补休止与延音：首音之前显示 0，当前音延续到本声部的下一次起音，末音延续到全曲结尾。最后一个默认声部不着色，其前各声部默认依次使用红、黄、绿、紫，避开用于选择的蓝色；V5 以后可手动启用颜色。增加声部时，原未标记内容会随默认行移到新的最后声部。",
      "谱面中的主音和倚音都可以直接点选：对应的键位或数字会在左侧 TXT 中高亮；在 TXT 中选择倚音也会反向高亮谱面左上角的小音符。Ctrl/Cmd 点击可多选，Shift 点击可连续选择。按 `1–7` 修改唱名，按 ↑ / ↓ 调整八度，键盘谱会自动换算回对应的 A–Z 键位。播放从当前主选择开始，清除选择后从开头播放。",
      "只要一个拍组含 `-` 且没有其他实际音符，就表示整组休止；因此 `/ - /`、`-/-/`、减号左右带空格或时值字符的结果相同，而数字谱的 `-1` 仍是低八度音。`{}` 与 `[]` 都可分别选择倚音、琶音、三连音或细分；例如空格=16分时，`[A B C ]` 会把三个名义十六分值按 3:2 压缩成总长一个八分音符的三连音。",
      "纵向单行谱默认以每行 4 小节为目标，并从调号 / 拍号 / BPM 下方开始；内容过密时会自动减少本行小节数。谱行按全局上下间距自动分页，下一页中能够放下的谱行会优先回填上一页空白。它与钢琴双行谱共用首页标题区。无效谱行的说明和其他文字会原样保留在 TXT 中，并作为注释忽略。",
      "默认键位对应关系是 `ZXCVBNM`=低八度 1–7、`ASDFGHJ`=中音 1–7、`QWERTYU`=高八度 1–7；可用 `#` / `b` 写临时升降号。",
    ],
  },
  {
    title: "钢琴左右手双行简谱",
    body: [
      "把原来的 `.Voice` 分成 `.Voice.RH`（右手）和 `.Voice.LH`（左手），右侧会按钢琴方式显示两条同步简谱行。",
      "两手的同拍音符和小节线共享横坐标，并显示大括号和贯穿小节线。`[1'3'5']` 这样的方括号写法会显示为纵向和弦。",
      "钢琴谱首页直接显示标题区：标题 / 副标题居中，调号 / 拍号 / BPM 在左，作词 / 作曲 / 编曲在右；调号、拍号和速度使用加大的成品谱字号，右下页码使用较小字号。每个系统以花括号加左竖线开始、双实线结束。花括号左侧只在全谱第一个系统显示较小的乐器名，默认是“钢琴”，可在选项中修改或在 `.Title` 写 `Instrument = {中文乐器名}`；后续系统不重复乐器名，但花括号最左尖点会与首个乐器名左边缘对齐。",
      "播放时双手同时发声并同步高亮；选项中可分别调整右手、左手音量，MIDI 导出为两个独立轨道。",
    ],
  },
  {
    title: "MIDI 多轨总谱",
    body: [
      "MIDI 至少含有 **3 条带有效音符的轨道**时，导入对话框才会提供“多轨总谱”；1 条按单谱行处理，2 条继续用于钢琴双手判断。进入总谱后可添加乐器并为每个乐器勾选轨道，每条轨道只能属于一个乐器。",
      "同一乐器勾选多条轨道后，可指定声部顺序：声部 1 在最上方，随后依次向下。保存后的段落名类似 `.Voice.钢琴.V1`、`.Voice.钢琴.V2`、`.Voice.小提琴.V1`。旧 `.Voice` 和 `.Voice.RH/.Voice.LH` 文件继续兼容。",
      "总谱中的全部声部共享小节与节奏横坐标；同一乐器的声部间距较小，两个及以上声部会像钢琴双手谱一样共用音乐花括号，每个乐器组下方各自显示节奏刻度线。不同乐器之间留出更宽的组间距；至少有两个乐器时，左侧总谱方括号才跨越整个系统，只有一个乐器时不画这层外括号。小节线只贯穿同一乐器组，分页时一个完整总谱系统不会被拆到两页。",
      "“选项”中的纸张尺寸可选择 A3 横向或纵向；播放混音和再次导出 MIDI 会按总谱声部分轨处理，并写入乐器/声部轨道名称。",
    ],
  },
  {
    title: "混排与乐句排版",
    body: [
      "**混排**：导入 MusicXML/ABC 后可用，切换 五线谱+简谱 对照排版；混排下代码区只读。",
      "**乐句排版**：按乐句自动断行，可随时切回原始排版。",
      "两者都只在导入乐谱后才可用（按钮平时禁用）。",
    ],
  },
  {
    title: "播放",
    body: [
      "工具栏 **播放** / **停止**，简谱模式下可试听；播放时当前发声的音符会高亮。若先点选了音符，则从当前主选择处开始播放；点击谱面空白处清除选择后，会重新从全曲开头播放。",
      "多声部时可在 **选项** 里调各声部音量。",
      "**macOS 桌面版**可使用系统原生音色，音质更好。",
    ],
  },
  {
    title: "导出",
    body: [
      "工具栏 **导出**。简谱模式可导出 **PNG**（当前页）、**PPTX**（矢量，逐页成幻灯片）、**MIDI**，也可导出 **键盘谱 TXT**、**数字谱 TXT** 和 **JPW 简谱**。键盘谱/数字谱 TXT 可分别勾选是否保留多声部隐形标记，以及是否包含 `// @jpeditor` 元数据；元数据默认保留，关闭后下次打开无法自动恢复拍号、速度与符号映射，需要手动重新设置。",
      "混排模式可导出 **PDF**：**桌面版**直接存盘，**浏览器版**走浏览器打印对话框（打印成 PDF）。",
    ],
  },
  {
    title: "选项",
    body: [
      "工具栏 **选项** 可设置页面与播放等全局选项；多声部 TXT 中的“文本声部着色”可一次关闭或恢复全部文本颜色，同时保留各声部原来的颜色配置。“乐谱设置”修改当前键盘谱/数字谱的识别和节奏参数；“排版”修改所有简谱共用的视觉样式。谱面比例支持 16:9 / 4:3 / A4 / A3，新安装默认使用 A4 纵向。",
      "多声部简谱还有各声部音量；混排模式下可勾选「隐藏小节号」。",
      "工具栏 **排版** 提供独立实时样张，可调整数字大小与粗细、真实音符横距、每行目标小节数、时值间距强度、末行铺满、谱行上下间距、和弦间距、八度点、升降号、延音线续音灰显、钢琴花括号与小节线。页面与谱行区域还可分别调整标题、副标题、调号/拍号/速度、作词/作曲/编曲的字号及横纵位置，并控制调拍速度信息到第一谱行的距离。拖动控件只改变对话框样张，当前单谱、双谱和多轨总谱保持不动；只有点击「应用到整个软件」后才保存参数并一次性重排当前及以后打开的谱面。",
      "八度点会贴近自己的数字，并在下一行数字前保留独立空白。短时值音符会比长时值音符更紧；普通小节优先等宽，密集小节自动借用同行其他小节的空间，仍放不下时再推到下一行。谱行上下间距会参与自动分页：调小会把下一页能容纳的谱行回填上一页，调大到放不下时才换页。跨越多个相同音或和弦的延音线会逐段连接，第二段以后的续音均灰显；播放和 MIDI 导出只产生一次持续发音。钢琴谱每行小节号与花括号左边缘对齐；三连音按 3:2 均分时值。钢琴专用项已单独标注。",
      "**节奏刻度线** 默认开启。工具栏“刻度”可快速选择全音符、二分、四分、八分、十六分、三十二分或六十四分网格；再次点击当前档位会回到自动。它既控制方向键每次移动的距离，也同步排版中的手动刻度密度。长刻度始终对应拍号中的每一拍，所有刻度按量化时刻与音符中心对齐；关闭刻度线只隐藏图形，不会禁用方向键节奏编辑。钢琴双行谱在左手下方显示双手共享刻度线。",
    ],
  },
  {
    title: "键盘快捷键",
    body: [],
    extra: shortcutTable,
  },
];

function shortcutTable(): HTMLElement {
  const rows: [string, string][] = [
    ["放大 / 缩小", "Ctrl/⌘ +  ·  Ctrl/⌘ -"],
    ["复位缩放 100%", "Ctrl/⌘ 0"],
    ["上一页 / 下一页", "PageUp  ·  PageDown"],
    ["首页 / 末页", "Ctrl/⌘ Home  ·  Ctrl/⌘ End"],
    ["按 Ctrl/⌘ 滚轮", "以指针为中心缩放"],
    ["选中音符前移 / 后移一格", "←  ·  →"],
    ["JPW 音符缩短 / 延长一格", "Ctrl/⌘ ←  ·  Ctrl/⌘ →"],
  ];
  const table = el("table", "help-shortcuts");
  for (const [act, key] of rows) {
    const tr = el("tr");
    tr.append(el("td", undefined, act), el("td", undefined, key));
    table.append(tr);
  }
  return table;
}

function buildFeatureHelp(): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(para("下面列出编辑器已有的功能，点标题展开查看详情。带徽标的功能在桌面版与浏览器版行为不同。", "help-intro"));
  for (const t of FEATURE_TOPICS) {
    const det = el("details", "help-topic");
    const sum = el("summary");
    sum.append(el("span", "help-topic-title", t.title));
    for (const b of t.badges ?? []) sum.append(el("span", "help-badge", BADGE_TEXT[b]));
    det.append(sum);
    for (const line of t.body) det.append(para(line));
    if (t.extra) det.append(t.extra());
    pane.append(det);
  }
  return pane;
}

// ---- 记谱法 ----------------------------------------------------------------

interface NoteEx {
  /** 小节标题。 */
  title: string;
  /** 「常用」或「进阶」定位标签。 */
  level: "常用" | "进阶";
  /** 说明段落（支持 **粗** 与 `代码`）。 */
  body: string[];
  /** 展示给用户看的源码（通常是 .Voice 里的一行）。 */
  code: string;
  /** 实际用于渲染的完整 jpwabc；缺省时用默认包裹 code。若 code 以 `.` 开头（含段头）则直接整体渲染。 */
  render?: string;
  /** 渲染独立的标题页（展示 Title/SubTitle/词曲 版式）而非乐谱内容页。 */
  titlePage?: boolean;
}

/** 把一段 .Voice 内容包成可渲染的最小完整 jpwabc（空标题，只设调号/拍号，避免抬头干扰）。 */
function wrapVoice(voice: string, key = "1=C", meter = "4/4"): string {
  return `.Title\nKeyAndMeters = {${key},${meter}}\n.Voice\n${voice}\n`;
}

const GLOSSARY: [string, string][] = [
  ["唱名 1–7", "简谱用数字 1234567 表示 do re mi fa so la si 七个音，`0` 是休止（不出声）。"],
  ["八度点", "音符上方或下方的小圆点，往上一个点高八度、往下一个点低八度。"],
  ["减时线", "写在音符**下方**的短横线，一条把时值减半（八分音符），两条再减半（十六分）。"],
  ["增时线", "音符**右侧**的横线 `-`，每条把时值延长一拍。"],
  ["附点", "音符右侧的小圆点 `.`，把时值延长一半（如四分附点 = 四分 + 八分）。"],
  ["小节线 / 拍号", "`|` 分隔小节；`拍号` 如 `4/4` 表示每小节四拍、以四分音符为一拍。"],
  ["调号", "如 `1=C` 表示 do 唱作 C，决定整首曲子的音高基准。"],
  ["连音线 / 延音线", "音符间的弧线：跨不同音高叫圆滑线（连奏），跨相同音高叫延音线（把两音连成一个长音）。"],
];

const NOTATION: NoteEx[] = [
  {
    title: "音符与休止",
    level: "常用",
    body: [
      "简谱用数字 **1–7** 表示七个唱名（do re mi fa so la si），**0** 表示**休止符**（该拍不发声）。",
      "音符之间可以留空格，也可以不留。",
    ],
    code: "1 2 3 4 5 6 7 0",
  },
  {
    title: "高低八度（八度点）",
    level: "常用",
    body: [
      "**八度点**：音符**上方**加一个 `'`（撇号）升高一个八度，**下方**加一个 `,`（逗号）降低一个八度；加两个点就是两个八度。",
      "在源码里写在数字**后面**：`1'` 是高音 do，`1,` 是低音 do。",
    ],
    code: "1, 1 1' 5, 5 5'",
  },
  {
    title: "钢琴双手与数字和弦",
    level: "常用",
    body: [
      "钢琴谱用 `.Voice.RH` 写右手、`.Voice.LH` 写左手；两个段落中的第 1、2、3……小节会自动上下配对。",
      "同一时刻的多个音写进方括号，例如 `[1'3'5']`，会纵向叠成一个数字和弦。两只手都可以使用和弦。",
    ],
    code: ".Title\nInstrument = {钢琴}\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n1' 2' 3' 4' |[1'3'5']--- |]\n.Voice.LH\n1,- 5,- |[1,3,5,]--- |]",
  },
  {
    title: "升号与降号",
    level: "常用",
    body: [
      "在数字**前**加 `#` 升半音、加 `b` 降半音。",
      "例如 `#4` 是升 fa、`b7` 是降 si。",
    ],
    code: "1 #1 2 #2 3 4 #4 5",
  },
  {
    title: "时值：减时线与十六分",
    level: "常用",
    body: [
      "**减时线**（音符下方的下划线 `_`）把时值减半：一条 `_` 是八分音符，两条 `__` 是十六分音符。",
      "相邻的短音符会自动用横梁连起来。",
    ],
    code: "1 2 3_ 3_ 4 5__ 5__ 5__ 5__",
  },
  {
    title: "时值：附点与增时线",
    level: "常用",
    body: [
      "**附点** `.`（音符右侧小圆点）把时值延长一半：`5.` 是附点四分音符。常与减时线搭配成 `5. 5_`（附点节奏）。",
      "**增时线** `-`（音符右侧横线）每条延长一拍：`5-` 是二分音符、`5---` 是全音符。",
    ],
    code: "5. 5_ 5 5 |1- 1 |1--- |",
  },
  {
    title: "小节线、拍号与调号",
    level: "常用",
    body: [
      "`|` 是**小节线**，分隔小节。曲子的**拍号**和**调号**写在 `.Title` 段的 `KeyAndMeters` 里，格式 `{声部号=调,拍号}`，如 `{1=G,3/4}`。",
      "拍号也可以在 `.Voice` 中途改变，直接写 `3/4` 这样的记号即可。",
    ],
    code: ".Title\nKeyAndMeters = {1=G,3/4}\n.Voice\n5 1' 1' |6 1' 1' |5 4 3 |2- 0 |",
  },
  {
    title: "反复记号",
    level: "常用",
    body: [
      "反复记号让一段乐句重复演奏：`|:` 是反复开始、`:|` 是反复结束，中间的小节要唱两遍。",
      "`||` 是双小节线（分句），`|]` 是终止线（曲终）。",
    ],
    code: "1 2 3 4 |: 5 6 7 1' :| 1--- |]",
  },
  {
    title: "连音线与延音线",
    level: "进阶",
    body: [
      "音符之间的弧线：跨**不同**音高是**圆滑线**（连奏、一弓/一口气唱），跨**相同**音高是**延音线**（把两个音连成一个更长的音）。",
      "在源码里用圆括号 `( ... )` 括住要连起来的音符。",
    ],
    code: "(5 6) (1' 1') 3 2 |1--- |",
  },
  {
    title: "延音记号（fermata）",
    level: "进阶",
    body: [
      "在音符**前面**写 `{YanYin}` 加**延音记号**（fermata，音符上方的「◠」），表示这个音可以自由延长。",
    ],
    code: "5 5 5 5 |{YanYin}1 - - - |]",
  },
  {
    title: "歌词",
    level: "常用",
    body: [
      "歌词写在 `.Words` 段。前缀 `W1@1,1:` 表示第 1 段歌词、从第 1 小节第 1 个音符开始对齐。",
      "每个字**默认对一个音符**；用 `/` 表示这个音符**不换字**（一字多音的拖腔）。多段歌词用 `W1` `W2` 分别写。",
    ],
    code: ".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5- 5- |\n.Words\nW1@1,1:\n我 们 歌 唱 主/爱/",
    render:
      ".Title\nTitle = {示例}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5- 5- |\n.Words\nW1@1,1:\n我 们 歌 唱 主/爱/\n",
  },
  {
    title: "标题信息",
    level: "常用",
    body: [
      "`.Title` 段放曲子的抬头信息：`Title` 是标题（居中显示在最上方）、`WordsByAndMusicBy` 是词曲作者（格式 `{词作者,曲作者}`）、`Instrument` 是钢琴双行首个系统左侧的乐器名；`KeyAndMeters` 设置调号与拍号。",
      "单行简谱与钢琴双行谱使用同一套首页抬头：标题、副标题居中，调号 / 拍号 / 速度在左，作词 / 作曲 / 编曲在右；不会再额外插入独立标题页或在页底重复标题。",
    ],
    code: ".Title\nTitle = {奇异恩典}\nKeyAndMeters = {1=G,3/4}\nWordsByAndMusicBy = {John Newton,美国民谣}\n.Voice\n5 1'. 1'_ 3' |2'- 1'- |",
    titlePage: true,
  },
];

function buildNotationHelp(app: App): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(
    para(
      "`.jpwabc` 是本项目使用的**纯文本简谱格式**，用普通文本分段描述乐谱：`.Title`（抬头）、`.Voice`（旋律，必需）、`.Words`（歌词）等，段头独占一行、以 `.` 开头。下面按**常用在前**的顺序介绍常见记号，每条都附实时渲染的效果。",
      "help-intro",
    ),
  );

  // 术语速查
  const gloss = el("details", "help-glossary");
  gloss.append(el("summary", undefined, "术语速查（点开）"));
  const dl = el("dl", "help-gloss-list");
  for (const [term, desc] of GLOSSARY) {
    dl.append(el("dt", undefined, term));
    const dd = el("dd");
    dd.append(rich(desc));
    dl.append(dd);
  }
  gloss.append(dl);
  pane.append(gloss);

  for (const ex of NOTATION) {
    const sec = el("div", "help-section");
    const head = el("div", "help-sec-head");
    head.append(el("span", "help-sec-title", ex.title));
    head.append(el("span", `help-level help-level-${ex.level === "常用" ? "common" : "adv"}`, ex.level));
    sec.append(head);
    for (const line of ex.body) sec.append(para(line));

    const card = el("div", "help-example");
    const pre = el("pre", "help-source");
    pre.textContent = ex.code;
    card.append(pre);

    const renderText = ex.render ?? (ex.code.trimStart().startsWith(".") ? ex.code : wrapVoice(ex.code));
    const svg = app.renderExampleSvg(renderText, { titlePage: ex.titlePage });
    if (svg) {
      const box = el("div", "help-render");
      svg.classList.add("help-svg");
      box.append(svg);
      card.append(box);
    }
    sec.append(card);
    pane.append(sec);
  }
  return pane;
}

/** 渲染出的示例 svg 默认是整页 viewBox；attach 到 DOM 后裁剪到内容紧包围盒。 */
function cropExamples(root: HTMLElement): void {
  for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>("svg.help-svg"))) {
    let bb: DOMRect;
    try {
      // svg.getBBox() gives the union bbox of all descendants in viewBox space,
      // accounting for their transforms (unlike a child <g>.getBBox()).
      bb = svg.getBBox();
    } catch {
      continue;
    }
    if (bb.width <= 0 || bb.height <= 0) continue;
    const pad = 6;
    const vw = bb.width + pad * 2;
    const vh = bb.height + pad * 2;
    svg.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${vw} ${vh}`);
    const dispH = Math.min(96, Math.max(36, vh));
    svg.style.height = `${dispH}px`;
    svg.style.width = `${(vw / vh) * dispH}px`;
  }
}

// ---- 对话框 ----------------------------------------------------------------

export function showHelpDialog(app: App): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box help-box");

  const title = el("div", "modal-title", "帮助");

  // 标签页头
  const tabs = el("div", "help-tabs");
  const tabFeature = el("button", "help-tab active", "功能帮助");
  const tabNotation = el("button", "help-tab", "记谱法");
  tabs.append(tabFeature, tabNotation);

  // 内容区
  const content = el("div", "help-content");
  const featurePane = buildFeatureHelp();
  const notationPane = buildNotationHelp(app);
  notationPane.style.display = "none";
  content.append(featurePane, notationPane);

  let cropped = false;
  const activate = (feature: boolean) => {
    tabFeature.classList.toggle("active", feature);
    tabNotation.classList.toggle("active", !feature);
    featurePane.style.display = feature ? "" : "none";
    notationPane.style.display = feature ? "none" : "";
    // getBBox only works once the pane is visible; crop on first reveal.
    if (!feature && !cropped) {
      cropExamples(notationPane);
      cropped = true;
    }
    content.scrollTop = 0;
  };
  tabFeature.onclick = () => activate(true);
  tabNotation.onclick = () => activate(false);

  const footer = el("div", "modal-footer");
  const closeBtn = el("button", undefined, "关闭");
  footer.append(closeBtn);

  box.append(title, tabs, content, footer);
  overlay.append(box);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  closeBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.addEventListener("keydown", onKey);
}
