import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 顶层渲染错误边界：任何组件渲染抛错都变成可读的错误页，而不是整页白屏。
 *
 * 只捕获渲染期错误（事件回调、异步请求里的错误不经过这里）。不做自动重试——
 * 渲染错误多半与响应数据形态有关（例如后端版本比前端旧、字段缺失），刷新页面
 * 重新拉取数据是最可靠的恢复手段。错误详情只在本地控制台输出，不自动上报。
 */
interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("界面渲染错误：", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="min-h-full flex items-center justify-center bg-surface p-6">
        <div className="card w-[460px] p-8 space-y-5">
          <div>
            <div className="font-reading text-[22px] text-primary">界面渲染出错</div>
            <div className="text-on-surface-variant text-[13px] mt-1">
              页面组件遇到意外数据，无法继续显示。你的数据不受影响；刷新后重试，若持续出现请检查后端与前端版本是否匹配。
            </div>
          </div>
          <pre className="input font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-all">
            {this.state.error.message}
          </pre>
          <button type="button" className="btn-primary w-full" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
