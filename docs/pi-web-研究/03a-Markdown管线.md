# pi-web Markdown 渲染管线研究（03a）

> 研究对象：`/tmp/pi-web`（agegr/pi-web，MIT）
> 只读文件三个：
> - `lib/markdown.ts`（364 行）
> - `components/MarkdownBody.tsx`（102 行）
> - `components/MermaidBlock.tsx`（300 行）
>
> 注：下述 `defaultSchema`（rehype-sanitize 自带白名单）内容为对 hast-util-sanitize **github-schema** 的说明性描述，不在目标文件内，未做运行时验证，标注为「默认 schema」。

---

## 0. 管线总览（数据流）

```
children (AI 生成的原始 Markdown 字符串)
  → normalizeDisplayMath()            MarkdownBody.tsx:19（展示数学公式预规整）
  → <ReactMarkdown remarkPlugins>     lib/markdown.ts:343-347
  → <ReactMarkdown rehypePlugins>     lib/markdown.ts:354-358
  → components 定制渲染               MarkdownBody.tsx:21-89（code/pre/a/img/table）
  → DOM
```

remark 阶段（字符串 → mdast）：`remark-frontmatter` → `remark-gfm` → `remark-math`
rehype 阶段（hast → hast）：`rehype-raw` → `rehype-sanitize` → `rehype-katex`

文本进渲染前还会过一次 `normalizeDisplayMath`（lib/markdown.ts:18-203），把模型输出的各种"不标准"数学公式写成 remark-math 能吃的形态，这是整个文件里最重的逻辑（约 186 行）。

---

## 1. 插件链完整配置

### 原文（lib/markdown.ts:343-364）

```ts
// lib/markdown.ts:343-347
export const markdownRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkMath,
];
// lib/markdown.ts:348-352
export const markdownPreviewRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [
  [remarkFrontmatter, ["yaml"]],
  [remarkGfm, remarkGfmOptions],
  remarkMath,
];

// lib/markdown.ts:354-358
export const markdownRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];
// lib/markdown.ts:360-364
export const markdownPreviewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
];
```

注意：全量版与 preview 版的 remark / rehype 插件数组**逐字节相同**（343-352 / 360-364 两对），只是分别导出两个名字。移植时合并成一套即可。

GFM 选项（lib/markdown.ts:341）：

```ts
const remarkGfmOptions = { singleTilde: false } as const;
```

设计意图注释在 lib/markdown.ts:338-340：`singleTilde:false` 要求删除线必须用 `~~双波浪~~`。单 `~` 是中文数字范围的惯用分隔符（如「5~7U」「100~200倍」），GFM 默认的单波浪删除线会静默破坏这类文本（原仓库 issue #385）。

frontmatter 设计意图注释在 lib/markdown.ts:335-337：先解析 YAML frontmatter 成 yaml 节点并从渲染中剔除，否则开头的 `---` 会变成 `<hr>`、结尾的 `---` 会把 YAML 正文变成 setext 标题。

### 各插件职责

| 插件 | 职责 | 为什么需要 |
|---|---|---|
| `remark-frontmatter` `["yaml"]` | 解析文档头部 `---` YAML 元数据为独立 yaml 节点 | AI 文档常带 frontmatter；不解析会泄露成 `<hr>` + setext 标题（lib/markdown.ts:335-337 注释） |
| `remark-gfm` | 表格、~~删除线~~、任务列表、自动链接等 GFM 扩展 | AI 输出大量使用 GFM 表格；`singleTilde:false` 保护中文数字范围 |
| `remark-math` | 把 `$...$` / `$$...$$` 识别成 math 节点（配合 `rehype-katex`） | 数学公式渲染；remark-math 严格的两侧 `$$` 自成一行是后面 normalizeDisplayMath 存在的根本原因 |
| `rehype-raw` | 把 Markdown 里嵌入的原始 HTML 解析成真正的 hast 元素节点 | 让 Markdown 里"漏出来的 HTML"（AI 常混写）能正确渲染，而不被当成纯文本 |
| `rehype-sanitize` 带自定义 schema | 白名单净化，剔除危险标签/属性 | 渲染不可信 HTML 的安全闸门，安全核心（见 §2、§3） |
| `rehype-katex` | 把 math 节点渲染成 KaTeX 的 HTML | 数学公式最终呈现；配置 `throwOnError:false`（渲染错误消息而不是抛异常）、`strict:false`（忽略严格模式警告） |

---

## 2. rehype-raw 与 rehype-sanitize 的顺序（安全关键）

### 顺序

**`rehype-raw` 在前，`rehype-sanitize` 在后，`rehype-katex` 最后**（lib/markdown.ts:354-358）：

```ts
rehypeRaw,
[rehypeSanitize, markdownSanitizeSchema],
[rehypeKatex, { throwOnError: false, strict: false }],
```

### 为什么必须是这个顺序

`react-markdown` 默认情况下（不装 `rehype-raw`）不会把 Markdown 里的 HTML 变成元素——原始 HTML 留在 hast 树里作为 `raw` 类型文本节点，输出时被丢弃/转义。

- **先 raw 后 sanitize**：`rehype-raw` 先把 `raw` 节点真正解析成 hast 的 `element` 节点，此时 `rehype-sanitize` 才能"看见"每个真实标签和属性，从而逐个做白名单过滤。净化发生在元素层面，才能删掉 `<script>`、`<iframe>`、`onclick` 这类危险内容。
- **顺序颠倒（先 sanitize 后 raw）的两个后果**：
  1. **功能层面**：sanitize 面对的是 `raw` 文本节点而非元素，游不到各标签内部做判断，`raw` 节点在净化过程中被移除（hast-util-sanitize 对非 text/element 节点默认丢弃），之后 `rehype-raw` 面对空树无物可解析 → HTML 静默消失。
  2. **安全层面（更危险的另一种实现路径）**：若 sanitize 对 `raw` 节点放行保留，随后 `rehype-raw` 再解析这些未经净化的 HTML 并注入 DOM，等于**净化形同虚设，直接产生 XSS 注入点**。无论落在哪种行为上，先 sanitize 后 raw 都同时破坏了功能与安全性。

`rehype-katex` 放在 sanitize **之后**也是有意为之：KaTeX 生成大量 `span`/MathML/`aria-` 属性，若 sanitize 跑在 katex 之后，这些产物会被白名单剥掉，公式渲染就坏了。

---

## 3. sanitize 白名单

### 配置原文（lib/markdown.ts:9-16）

```ts
const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
};
```

```ts
// lib/markdown.ts:14-16（带行号的再贴一次）
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  strip: [...(defaultSchema.strip || []), "iframe", "object", "style", "form"],
```

`defaultSchema`（`import { defaultSchema } from "rehype-sanitize"`，lib/markdown.ts:4）是 hast-util-sanitize 的 **github-schema**（GitHub 语境的 HTML 白名单）。本项目**复制展开后只改了两处**：

1. **扩展 `attributes.code`**：给 `<code>` 的 `className` 额外放行两类值
   - 匹配 `/^language-./` 的所有语言类名 → 供 `MarkdownBody.tsx` 识别代码语言、供语法高亮取 `language-*`（MarkdownBody.tsx:23）；
   - 字面量 `"math-inline"`、`"math-display"` → 这是 `remark-math` 给 math 节点加的类名，`rehype-katex` 靠它定位。不放行这两个类，sanitize 会把公式类名剥掉、KaTeX 渲染失效。
2. **扩展 `strip`**：把 `iframe`、`object`、`style`、`form` 从"默认非白名单标签"进一步显式列入 `strip`。

关于 `strip` 的语义（hast-util-sanitize）：列在 `strip` 里的标签会把**该标签本身移除，但保留其内部子节点/文本**；与之相对，不在 `tagNames` 白名单、也不在 `strip` 里的标签则**连同子节点整体丢弃**。因此这里的意思是把这四个危险容器标签"拆掉外壳、文字留下来"（例如 `<iframe>` 的回退标注文字仍可见，而 `<script>` 这类连内容一起消失）。这一语义推动作者把它们显式加进 strip，是因为默认的 github-schema 对未知标签走的是整棵子树丢弃，作者希望在这四个场景下保留可见文本。⚠️ 该语义描述基于对 hast-util-sanitize 文档的了解，**在移植时需用一个最小用例跑一遍代码确认**（本环境沙箱无 node_modules，无法实测）。

### 允许哪些 HTML 标签

项目自己没有定义标签清单，**全部继承 `defaultSchema`（github-schema）**，语义是"常用的静态内容标签"：

- 标题/文本：`h1-h6`、`p`、`br`、`em`、`strong`、`b`、`i`、`code`、`s`、`del`、`ins`、`sub`、`sup`、`q`、`kbd`、`samp`、`var`、`u`、`mark`、`small` 等
- 块级：`div`、`span`、`blockquote`、`pre`、`hr`、`details`/`summary`、`figure`/`figcaption`、`dl`/`dt`/`dd` 等
- 列表：`ul`、`ol`、`li`
- 表格：`table`、`thead`、`tbody`、`tfoot`、`tr`、`td`、`th`
- 链接与图片：`a`、`img`
- 内联排版：`ruby`/`rt`/`rp`、`abbr`、`cite`、`time` 等少量

**不**允许：`script`、`style`、`iframe`、`object`、`embed`、`form`、`input`、`button`、`select`、`textarea`、`svg`、`video`、`audio`、`marquee` 等一切可执行/可交互/富交互标签。（`iframe/object/style/form` 额外进 strip。）

### 允许哪些属性

继承默认 schema，有协议协议、清除、防 DOM 接管几层保护：

- `a[href]`、`img[src]` 等仅允许已有 `protocols` 列表内的链接协议，默认协议白名单为 `http`、`https`、`mailto`（`javascript:`、`vbscript:`、`data:` 等非安全协议一律剥除）；
- 事件属性（`on*`）全部不允许；
- `style` 等内联样式属性默认不白名单（github 语境不依赖内联样式）；
- **clobber 防护**：默认 `clobberPrefix`（github 语境为 `user-content-`）会给 `id`/`name` 加前缀，防止恶意 HTML 用特殊 `id`/`name` 覆盖全局对象（DOM clobbering）；
- 除上面显式放行的 `code[className]` 外，**其它元素上的 `class`/`className` 默认不被保留**。这一点对"渲染带样式的 essence HTML 文档"是移植时的主要权衡点（见 §7）。

本项目**没有**放宽协议白名单、`on*` 事件、`style` 属性，也没有给其它标签放行 `class`——也就是默认 schema 之外的扩展仅有 §3 列出的 `code` 类名 + strip 四项。

---

## 4. 代码高亮

`react-syntax-highlighter`，使用 **`Prism`（完整版）** 构建。

### 原始引用（MermaidBlock.tsx:4-6, 280-297）

```ts
// MermaidBlock.tsx:4-6
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
```

```tsx
// MermaidBlock.tsx:280-297
        <SyntaxHighlighter
          language={lang || "text"}
          style={isDark ? vscDarkPlus : vs}
          showLineNumbers
          lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
          customStyle={{
            margin: 0,
            padding: "11px 13px",
            fontSize: 12.5,
            lineHeight: 1.62,
            borderRadius: 0,
            background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {code}
        </SyntaxHighlighter>
```

- **主题**：浅色 `vs`、深色 `vscDarkPlus`（均从 `dist/cjs/styles/prism` 引入），随 `useTheme()` 的 `isDark` 切换。
- **语言**：从 `code` 节点的 `language-*` 类名得出（MarkdownBody.tsx:23），落到 `SyntaxHighlighter` 的 `language` prop。
- **是否按需加载**：**否**。引入的是 `Prism`（全量构建）而非 `PrismLight`，也没有 `registerLanguage`——**所有 Prism 语言全部打进产物**，是相当重的一块包体（这也是高亮块"流式期间不高亮"的设计动机之一）。
- **流式性能防御**（MermaidBlock.tsx:230-239 注释、266-278）：消息仍 streaming 时整块渲染成普通 `<pre>`（monospace 明文），流结束后才交给 Prism tokenize。原因写在注释里：流式期间反复对增长中的块做高亮 tokenize，是流式渲染中最昂贵的部分；且 `CodeBlock` 用 `memo` 包裹，父级 markdown 因别处流式更新而重渲染时不会重跑 tokenization。

---

## 5. Mermaid 集成

### 初始化（MermaidBlock.tsx:35-70）

组件是 `"use client"`（MermaidBlock.tsx:1）。Mermaid 通过**动态 `import("mermaid")` 在 `useEffect` 里按需加载**，初始化配置（MermaidBlock.tsx:42-48）：

```ts
const { default: mermaid } = await import("mermaid");
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: isDark ? "dark" : "default",
});
```

关键点：
- `startOnLoad:false`——不自动扫描页面，只渲染当前 id；
- `securityLevel:"strict"`——**安全关键**：Mermaid strict 模式下会净化自身输出的 SVG（转义实体、禁用其中的链接点击/脚本执行），这是它敢用 `dangerouslySetInnerHTML` 注入 SVG 的底气；
- `suppressErrorRendering:true`——避免 Mermaid 出错时往 DOM 写错误文本；
- `theme: isDark ? "dark" : "default"`——**主题跟随暗色模式**。

### 渲染失败回退（MermaidBlock.tsx:50-65）

```ts
const parsed = await mermaid.parse(code, { suppressErrors: true });
if (!parsed) throw new Error("Invalid Mermaid diagram");

const id =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `mermaid-${crypto.randomUUID()}`
    : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const result = await mermaid.render(id, code);
if (!cancelled) {
  setRenderState({ key: currentKey, status: "ready", svg: result.svg });
}
```

```ts
render().catch(() => {
  if (!cancelled) setRenderState({ key: currentKey, status: "error" });
});
```

失败表现（MermaidBlock.tsx:88-91）：`RenderState` 三态机（`loading` / `error` / `ready`，类型定义在 21-24 行），error 态渲染 `i18n.invalidMermaid` 的错误占位块，loading 态渲染带 `aria-label` 的加载占位。没有 React ErrorBoundary，靠 async `.catch` + 状态机。`cancelled` 标志防止卸载/主题切换后仍 setState。渲染用 `parser: TS`-级预校验（`mermaid.parse` + `suppressErrors:true`），非法图在 render 前就抛。

### SSR 兼容

- 组件整体在 `"use client"` 内（MermaidBlock.tsx:1）；
- mermaid 只在 `useEffect` 内（MermaidBlock.tsx:35-70）动态 `import("mermaid")`——**服务端完全不会加载/执行 mermaid**；
- 渲染还受 `previewVisible = showPreview && !isStreaming`（MermaidBlock.tsx:33）门控，流式期连按钮都是禁用态（`disabled={isStreaming}`，77 行），只有流式结束后才进入渲染分支。

### 主题跟随

跟。`currentKey = `${isDark ? "dark" : "light"}\n${code}``（MermaidBlock.tsx:32），`useEffect` 依赖数组含 `isDark`（70 行）——暗色切换会带着「dark/default」新主题重新 `initialize` 并重渲染，且通过 `currentKey` 丢弃旧主题的旧渲染结果。

### 值得留意的点

SVG 经 `dangerouslySetInnerHTML` 注入（MermaidBlock.tsx:101 预览按钮、215 缩放弹窗），信任边界完全押在 `securityLevel:"strict"` 上。日志来自 `t`/`useTheme`/`copyText` 等自定义基建。

---

## 6. KaTeX 数学公式

### 配置

```ts
// lib/markdown.ts:346, 357
remarkMath,
[rehypeKatex, { throwOnError: false, strict: false }],
```

- remark 侧：`remark-math`，**无选项** → 采用默认分隔符：行内 `$...$`、块级 `$$...$$`。
- rehype 侧：`rehype-katex`，`throwOnError:false`（公式错误渲染成红字而非抛异常崩页）、`strict:false`（忽略 KaTeX 严格模式警告）。
- ⚠️ 三个文件里没有 KaTeX 的 CSS 引入，需确认全局样式（如全局 `katex/dist/katex.min.css`）；移植时这一条是显式 TODO。

### 但真正的"分隔符兼容层"是 `normalizeDisplayMath`

AI 模型输出的公式分隔符远比 remark-math 的默认形态混乱，`lib/markdown.ts:18-203` 在进渲染前做规整，覆盖（部分注释直接给出了设计意图）：

- `\(...\)`（LaTeX 行内）→ `$...$`（`normalizeInlineLatexMath`，lib/markdown.ts:314-329；带护栏，见下）；
- `\[...\]`（LaTeX 块级）→ `$$` 块（单行 `\[]`：74-90；多行：105-121；护栏边界 278-294——不做跨块配对）；
- `$$...$$` 单行内联写法 → 拆成三行 `$$` 围栏（123-137）；
- 开头/结尾 `$$` 粘在公式首末行上的多行块 → 重写成标准 `$$` 围栏（144-168，`findDisplayMathClose` 211-239）；
- 裸 `$$` 起手式 + 结尾 `$$` 粘行 → 同样规整（178-197）；
- **列表项内的懒续行问题**（多段注释强调）：公式嵌在 GFM 列表项里时，内容行在列 0 会被当作 lazy continuation，导致 remark-math 误判围栏配对、吞掉整个文档——规整时给内容行补缩进（`indentDisplayMathContent`，270-276；注释见 78-82、109-110、127-129）；
- 反引号代码段/裸 `<code>/<pre>/<script>/<style>` 内的 `$$` 不碰（20-73 的状态机跳过）；
- 数学表达式启发式（`isLikelyMathExpression`，331-333）：非转义 `[...]` 中间有 `\LaTeX` 命令才看成公式，避免误伤普通方括号。

`normalizeInlineLatexMath` 的护栏（lib/markdown.ts:315-323）：链接引用定义 `[x]: url`、`](`（markdown 链接语法）、HTML 注释/标签、`http(s)://`/`mailto:`/`file:`、`C:\` 这种 Windows 盘符——全部原样放行不转换，防止把 URL 路径破坏成公式。

---

## 7. 移植评估

### 能整体拿走吗

**核心管线可以整段搬走**，且值得。安全模型（raw→sanitize→katex）、数学规整、Mermaid strict 模式、流式廉价渲染这些都是针对"渲染 AI 生成长文"场景打磨过的。文件本体及其外部依赖如下：

**直接搬运（无耦合）**：`normalizeDisplayMath` + markdown.ts 的插件导出 + `ReactMarkdown` 渲染骨架。
**第三方依赖**：`react-markdown`、`remark-frontmatter`、`remark-gfm`、`remark-math`、`rehype-raw`、`rehype-sanitize`、`rehype-katex`、`react-syntax-highlighter`、`mermaid`。版本需对齐 pi-web 的 package.json（本次未读，作为移植第一步核查）。
**仓库内自定义基建（需替换/桩化）**：
- `useTheme()` / `useI18n()`（MermaidBlock.tsx:7-8；MarkdownBody 未直接用到，但 CodeBlock/MermaidBlock 依赖）——换成我们自己的主题与 i18n；
- `copyText`（`@/lib/clipboard`）、`resolveLocalFileHref`（`@/lib/file-links`）、`encodeFilePathForApi`（`@/lib/file-paths`）——本地文件打开/内嵌图片走 `/api/files/...`，是 pi-web 特有的"Markdown 里引用工作区文件"能力，我们的 essence 场景若不需要可直接删掉 `a`/`img` 定制逻辑。

### 针对"渲染 AI 生成的 Markdown + HTML（essence 是 HTML 文档）、高安全要求"的调整点

1. **sanitize 白名单与 essence HTML 的主要矛盾**：默认 schema + 现有扩展，除 `code` 外**不给任何标签放行 `class`**，`style` 属性不白名单。essence 文档若依赖 class / inline style 保样式，会被剥成纯文本节点。建议：**不要放行 `style`**（`style` 是 CSS 注入面），而是建立"essence class → 我们自己的 CSS"的映射表，需要时再白名单少量标签的 `className`。iframe/object/form/style 已在本 schema 里被 strip，属于自带的安全基调，正好符合高安全诉求。
2. **HTML 文档的入口**：essence 是纯 HTML 时，不必走 `react-markdown`，可复用**同一条 sanitize schema**：`rehype-parse`（`fragment:true`）→ `rehype-sanitize(markdownSanitizeSchema)` → 渲染。这样 Markdown 与 HTML 两条路共用同一份白名单，避免两套放行标准漂移。
3. **KaTeX CSS**：确认引入 `katex/dist/katex.min.css`，否则公式无样式。
4. **Mermaid 的 `dangerouslySetInnerHTML`**：SVG 注入信任边界押在 `securityLevel:"strict"`。高安全环境可再加一道 `DOMPurify.sanitize(svg, {USE_PROFILES:{svg:true, svgFilters:true}})`（MermaidBlock.tsx:101 与 215 两处）。另注意 Mermaid 交给不可信 LLM 生成的图时，即使 strict 也建议做渲染超时/大小上限防御。
5. **代码高亮包体**：全量 `Prism` 极重。若在意包体，改用 `PrismLight` + 按需 `registerLanguage`（语言清单从 `language-*` 类名动态淘）；若沿用全量版，保留"流式中略过高亮 + memo"这两个性能手段即可。
6. **数学**：`normalizeDisplayMath` 一定要带（AI 输出的 `\(\)`/`\[\]` 与粘行 `$$` 是常态，不带会大面积渲染成垃圾）；`throwOnError:false` 保持，让错误公式显示为可读错误而非整页崩溃。
7. **清理**：全量/preview 两套插件导出相同（§1），搬过来合一套；`singleTilde:false`、frontmatter 先解析这两处小锦囊建议原样保留。
8. **待实测项**：§3 中 `strip` 的确切语义（保留子节点 vs 连子节点删除）我在无 node_modules 的沙箱中无法验证，移植时用最小用例确认；`defaultSchema` 的精确标签/属性/协议清单以 `node_modules/rehype-sanitize` 的导出为准（本文描述基于 hast-util-sanitize github-schema 的说明性认知）。

---

## 附：MarkdownBody 组件定制渲染摘要（MarkdownBody.tsx）

- `components` 用 `useMemo`（21-89）稳定渲染器身份，注释说明目的是"消息 hover 重渲染时保持有状态组件（如 Mermaid）保持挂载"——`凯app`小细节对会话流式界面很重要。
- `code`（22-40）：`language-*` 类名 → 块级；`mermaid` 语言 → `MermaidBlock`；其余块级 → `CodeBlock`；判断阈值 `className.includes("language-") || raw.includes("\n")`；行内 → 普通 `<code class="markdown-inline-code">`，**不经过语法高亮**。
- `pre`（41-43）：直接返回 `children`——因为 `CodeBlock`/`MermaidBlock` 自带包裹容器，避免 `<pre><div>…</div></pre>` 嵌套坏结构。
- `a`（44-71）：`onOpenFile` 存在且为本地文件时拦截点击并 `openFile(filePath)`；否则渲染 `<a target="_blank" rel="noopener noreferrer">`。`rel` 安全默认保留。带修饰键（meta/ctrl/shift/alt）或非左键不拦截。
- `img`（72-81）：本地路径经 `encodeFilePathForApi` 走 `/api/files` API，`loading="lazy"`。
- `table`（82-88）：套一层 `.markdown-table-wrap`（横向滚动）。