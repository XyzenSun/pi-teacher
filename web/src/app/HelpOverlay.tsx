import { useNavigate } from "react-router-dom";
import { useWorkspaceRoute } from "./overlay-routes.ts";
import { Modal } from "../ui/Overlays.tsx";

/**
 * 帮助指南：只写本产品真实存在的概念与操作。
 * 内容与实现保持同步——新增或改变交互时必须回来更新对应条目。
 */

interface HelpSection { title: string; icon: string; items: Array<{ term: string; detail: string }> }

const SECTIONS: HelpSection[] = [
  {
    title: "基本结构",
    icon: "account_tree",
    items: [
      { term: "Space", detail: "学习内容的容器，只负责归类。左栏「学习」下的每个 Space 可以自己命名，「复习」是系统固定的一个 Space。" },
      { term: "对话（Pi Session）", detail: "真正与老师交流的单位。每个对话有独立的工作目录、AGENTS.md、教学风格文件与消息记录，互不影响。" },
      { term: "助教", detail: "第三栏下半部分的独立对话，用来问「这段刚才在讲什么」这类元问题。它是单独一个会话，不会污染主对话的上下文。" },
    ],
  },
  {
    title: "学习与复习",
    icon: "school",
    items: [
      { term: "学习对话", detail: "新建时选择所属 Space、Agents Md 模板与可选的教学风格。老师按模板的职责展开讲解。" },
      { term: "复习对话", detail: "新建时可指定 Topic 或选「全部」。老师会根据到期卡片组织提问，复习判定写入复习记录并更新下次到期时间。" },
      { term: "制卡开关", detail: "决定老师能否提议记忆卡片。关闭时相关工具会被直接拒绝，不是靠提示词约束；对话进行中也可以在输入区随时切换。" },
      { term: "教学风格", detail: "语气与节奏偏好。在输入区切换后，当前对话会以新风格重新载入，历史消息与已选模型都会保留。" },
    ],
  },
  {
    title: "卡片与审批",
    icon: "style",
    items: [
      { term: "提议卡片", detail: "老师做出的卡片先进入待审批状态，只有你确认后才进入复习调度。第三栏上半部分一次显示一张，可左右切换与翻面。" },
      { term: "确认 / 拒绝", detail: "确认后卡片进入正常状态并开始排期；拒绝的卡片不会进入复习。两者都可以在管理面板的 Card 页复查。" },
      { term: "回收站", detail: "删除正常卡片只是移入回收站，复习进度保留，可在管理面板恢复。" },
      { term: "Topic", detail: "卡片的归属单位，也决定该主题的目标保留率与最大间隔。Topic 不可删除，以保证历史卡片可追溯。" },
    ],
  },
  {
    title: "输入区技巧",
    icon: "keyboard",
    items: [
      { term: "@ 引用文件", detail: "输入 @ 后可以模糊搜索当前对话工作目录下的文件与目录，选中后会插入引用路径。" },
      { term: "/ 斜杠命令", detail: "在空输入框开头输入 / 会列出当前会话可用的命令。" },
      { term: "Enter 与 Shift+Enter", detail: "Enter 发送，Shift+Enter 换行。使用输入法时，候选词的回车不会误发送。" },
      { term: "插话与追问", detail: "老师正在回答时发送消息默认是「插话」，会打断当前回答；勾选「排队为下一轮追问」则等这轮结束再发送。" },
      { term: "附件", detail: "点击回形针按钮、或直接粘贴截图 / 文件即可上传，保存在该对话自己的 files/ 目录。图片会直接进入对话；其他文件只会把路径告诉老师，由老师决定怎么读。" },
    ],
  },
  {
    title: "左下角四个入口",
    icon: "apps",
    items: [
      { term: "系统设置", detail: "管理面板，含卡片、术语、Topic、Agents Md（含全局 AGENTS.md）、教学风格、用户偏好，以及账号、模型 Provider 与高级配置。" },
      { term: "用户偏好", detail: "写给老师的全局长期偏好（讲解方式、已掌握的基础等），下次打开或重载对话时生效。只针对某次对话的要求直接在对话里说，老师会记到该对话自己的 pi-session-user.md。" },
      { term: "学习日历", detail: "未来到期分布与最近复习记录，全部由真实调度数据聚合，没有估算指标。" },
      { term: "知识卡库", detail: "直接打开管理面板的 Card 页，可按状态与 Topic 筛选、编辑与新建卡片。" },
      { term: "帮助指南", detail: "就是当前这一页。" },
    ],
  },
  {
    title: "会话状态",
    icon: "sync",
    items: [
      { term: "已连接 / 重连中", detail: "顶部状态标签反映实时连接。网络中断时浏览器会自动重连，重连成功后会重新拉取一次完整上下文。" },
      { term: "已回收", detail: "长时间空闲的会话会被回收以释放资源。再次发送消息会按原有记录重新打开同一个会话，历史不丢失。" },
      { term: "切换模型", detail: "在输入区选择模型即刻生效于当前对话；运行中不能切换。可选模型来自管理面板中配置的 Provider。" },
    ],
  },
];

export function HelpOverlay() {
  const navigate = useNavigate();
  const { basePath } = useWorkspaceRoute();

  return (
    <Modal title="帮助指南" subtitle="按当前版本的真实行为撰写" size="lg" onClose={() => navigate(basePath)}>
      <div className="space-y-6">
        {SECTIONS.map((section) => (
          <section key={section.title} className="space-y-2">
            <h3 className="font-reading text-[17px] text-primary flex items-center gap-1.5">
              <span className="icon text-[18px] text-secondary">{section.icon}</span>{section.title}
            </h3>
            <dl className="card divide-y divide-line">
              {section.items.map((item) => (
                <div key={item.term} className="px-4 py-2.5 flex gap-4">
                  <dt className="w-[104px] shrink-0 text-[13px] font-medium text-primary">{item.term}</dt>
                  <dd className="text-[13px] text-on-surface-variant">{item.detail}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
