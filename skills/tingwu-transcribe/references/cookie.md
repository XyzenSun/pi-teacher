# Cookie 获取、更新与失效处理

网关鉴权完全依赖听悟登录 Cookie。Cookie 等同登录凭证：勿外传、勿提交进 git（cookie.txt 落盘权限已限 600）。

## 获取 Cookie

只接收**纯 Cookie 值**，不接收 cURL 命令、不接收 `Cookie:` 前缀：

```text
account_info_switch=close; login_current_pk=1501344461225917; hssid=...; cna=...; ...
```

在浏览器中打开 `tingwu.aliyun.com`，按 `F12` → Network → 找一条请求 → Headers → Request Headers → 复制 `Cookie` 右侧的完整值（不要复制 `Cookie:` 这几个字）。

注意：不要用控制台 `document.cookie` 取值 —— 登录 Cookie 是 HttpOnly 的，会取不全。

## 更新 Cookie（推荐接口）

```bash
curl -X POST http://127.0.0.1:8787/cookie \
  -H 'content-type: text/plain' \
  --data-binary 'account_info_switch=close; login_current_pk=...; hssid=...'
```

后端会先用新值真实访问听悟任务列表验证，验证成功后才保存并返回任务列表；验证失败不会覆盖原来的 Cookie。

也可以在 WebUI（`http://127.0.0.1:8787/`）右上角点击「更新 Cookie」，直接粘贴纯 Cookie 值。

## 主动检查当前 Cookie

```bash
curl -s http://127.0.0.1:8787/cookie/check
```

## 失效行为

Cookie 失效后（听悟返回 `CMN.NotLogin` 或非 JSON 登录页重定向），网关自动标记为 `invalid`，暂停转写、列表、结果和导出请求（全部 401 `COOKIE_INVALID`）；更新 Cookie 后自动恢复。

`GET /health` 的 `cookieState` 字段：`missing`（未配置）/ `unknown`（已加载未验证）/ `valid` / `invalid`（附 error 说明）。

## 引导用户提供 Cookie 的话术要点

1. 说明需要听悟网页版的登录 Cookie 才能调用转写
2. 给出上面的 F12 获取步骤
3. 提醒只粘贴纯 Cookie 值（`name=value; name2=value2`），不要带 `Cookie:` 前缀或整个 cURL
4. 收到后通过 `POST /cookie` 提交，把验证结果（任务列表）反馈给用户
