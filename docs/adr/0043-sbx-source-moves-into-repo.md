# sbx 源码转入本仓库，sourcecode/ 即权威

> 状态：现行。更新 ADR-0040 中「sbx 源码或重建方法留在 sourcecode/（指向 npm 包与上游仓库）」「平台切换由上游 CLI 负责」的定位——上游归档，本仓库 `skills/sbx/sourcecode/` 成为唯一权威源码。

`@xyzensun/sbx` 的源码从上游仓库 `sandbox-cli`（codeup）转入本仓库 `skills/sbx/sourcecode/`，此后对 sbx 的全部改动直接改这里。**产物形态不变：仍是 esbuild 单文件 node cli（`scripts/sbx`），本轮产物未重打**——迁入的源码就是现有 bundle 的来源（上游 0.1.0），两者严格对应。

## 迁入内容与去留

从上游 `sandbox-cli` @ 0.1.0 原样复制：

- `src/`（11 个 TS 文件 1783 行：三家 provider、dockerfile 解析、平台注册、CLI 入口）
- `package.json` / `package-lock.json` / `tsconfig.json`
- 上游 `README.md` 原样存为 `UPSTREAM-README.md`（npm 包视角的完整 CLI 文档，含三家反代环境变量 `DAYTONA_API_URL` / `E2B_DOMAIN` / `E2B_API_URL` / `CODESANDBOX_API_URL` 一表，`SKILL.md` 未覆盖，留作参考）

排除：Windows 残留空文件 `nul`、`.git`。**不带入上游 `SKILL.md`**——本仓库的 SKILL.md 是 Pi Teacher 适配版（`scripts/sbx` 相对路径调用、key 由后端作为环境变量注入、明确不使用 `--envfile`），与上游 npm 包视角（探测 `sbx` / `npx`、`--envfile` 加载）有实质分叉，以本仓库版为准。

`sourcecode/README.md` 重写为本仓库视角的权威说明：目录职责、构建方法（改为以本目录为根，不再从 npm 安装）、与 `UPSTREAM-README.md` 的关系。

## 为什么收进来

- **上游只有本人维护，无外部用户**：npm 包没有下载量来源，双仓库只剩流程成本——改一行 sbx 要跨仓库 commit、发 npm、回本仓库重打 bundle，三步里任何一步忘了就出现「源码与产物脱节」。
- **规模小**：1783 行 TS，进本仓库不构成负担；三家 SDK 依赖仍只在构建时需要（重打时临时 `npm install`），不进本仓库任何 manifest。
- **改动频率预期升高**：提示词与 skill 完善是当前任务（`docs/tasks/prompt-and-skill-polish.md`），sbx 的输出文案、错误提示都在优化面上，权威在手边才能顺手改。

## 产物为什么仍是 bundle 而不是源码直跑

重申 ADR-0040 的实测账：三家沙箱 SDK 的 `node_modules` 共 445M（运行镜像才 701M）；容器内 `npx` 首拉 286 秒且缓存随容器重建丢失。esbuild bundle 把依赖树压成 4.4M 纯 JS 单文件，`COPY skills/` 即进镜像、entrypoint 复制即用、离线可用。源码转入改变的只是**开发面**：改代码 → 本目录重打 → 提交产物，全程不出仓库。

## Consequences

- `--envfile`（`src/envfile.ts`）**原样保留**：迁入原则是与现有 bundle 严格对应，不做任何源码改动；Pi Teacher 场景不用它（key 走后端注入），但上游文档与 CLI help 里它存在。是否删除等首次真正改 sbx 源码时再定，届时产物须重打。
- 重打命令的安装源从「`npm install @xyzensun/sbx`」改为「在本目录 `npm install` 后 bundle `src/index.ts`」，见 `sourcecode/README.md`。
- 开源边界：`sourcecode/package.json` 的 `repository` 字段指向 codeup 私有仓库。**下次向 main 同步时，其 `.gitignore` 需把现有的 `/skills/sbx/sourcecode/README.md` 排除项扩为整个 `/skills/sbx/sourcecode/`**（开源快照只带 bundle 产物，不带源码，与转入前的开源形态一致）。已记入 TODO。
- 上游仓库与 npm 包保留不动（归档态），不再从它们构建。
