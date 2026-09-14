# 图片展示改缩略图 + 点击放大（yet-another-react-lightbox）

## 背景

img_display 当前形态（ADR-0044 方案 A）是折叠卡外常显大图（max-w 480px）、点击新开原图标签页。大图占屏，连续多图时对话被拉得很长；新开标签页也打断阅读。

对比稿（`docs/前端模板/图片展示形态对比.html`）里的方案 C（缩略图 + 灯箱）被选为改进方向。

## 决策（用户拍板）

- **库**：yet-another-react-lightbox（MIT、零依赖、peer 支持 React 16.8–19、插件体系、CSS 变量换肤、活跃维护）。备选 react-photo-view（更轻但无工具栏）与 PhotoSwipe（需自写 React 包装）已排除；lightGallery 因 GPLv3 排除（会传染 main 开源分支）。
- **范围**：只改 img_display 的展示图；用户上传的图片附件（UserBubble）维持现状。
- **形态**：默认 150px 缩略图（对比稿 C 尺寸，可调），点击灯箱放大。

## 实现

1. `web/package.json` 增加 `yet-another-react-lightbox` 依赖（含 Zoom / Download 插件按需引入）。
2. `MessageView.tsx` 的 `ToolCallView`：`details.displayImage` 的渲染从 `<a><img></a>` 改为缩略图 `<img>`（w-[150px]）+ 点击打开 Lightbox；灯箱内启用 Zoom（滚轮/双击缩放，看图表细节）与 Download（下载原图）插件。
3. 灯箱主题用 CSS 变量对齐 Atelier Mind 令牌（遮罩、按钮色），不引入额外全局样式文件。
4. 历史重载路径不变：URL 仍走 `GET /api/images`，灯箱只是前端展示层替换。

## 验证

- 前端 typecheck + build（新依赖进 bundle，确认体积增幅合理）；
- 浏览器手验：img_display 出 150px 缩略图、点击灯箱打开、缩放、下载、Esc/点遮罩关闭；刷新后历史里缩略图与灯箱行为一致。
