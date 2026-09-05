# 不引入 Anki，卡片仓库与调度自建

Anki 是间隔重复领域的默认选择，未来读者一定会问为什么不用它，因此记录这次评估。

核实结论是：功能假设基本成立。AnkiConnect 的 `answerCards` 接受 ease 1–4，正好对应四档评级，且走 Anki 真正的调度器、不要求 GUI 处于复习界面；note/card CRUD 完整；TypeScript 客户端 `yanki-connect` 维护正常。但它是**社区插件，寄生在 Anki 桌面进程内**，官方 README 明确要求客户端常驻。官方本身不提供 HTTP API：自托管 sync server 只实现同步协议且不加载任何插件，官方并明确拒绝 REST API 类的贡献，把该需求指向 AnkiConnect。唯一能力完整的无 GUI 路径是官方 Python 库 `anki`，需要引入 Python sidecar，与 ADR-0001 的全栈 TypeScript 冲突。

## 否决理由

- **核心复习循环会依赖一个常驻 GUI 桌面进程。** AI 评价必须发生在本产品界面内，评价后再回调打分；Anki 进程中断即复习中断。服务器部署需要 Xvfb/offscreen 容器跑完整桌面客户端，社区镜像自报长跑内存泄漏、需定期重启。
- **数据层无法并发访问。** Anki 打开 collection 时使用独占锁，第三方进程读写立即失败；绕过 Anki 直改数据文件不被官方支持，且会破坏同步所依赖的 usn 机制。
- **读不到卡片级 FSRS 记忆状态。** stability / difficulty 存在 `cards.data` 的 JSON 列中，AnkiConnect 未暴露。
- **与 ADR-0003 的调度覆写机制冲突。** 若调度归 Anki，覆写只能走 `setDueDate`，而这是官方已知会破坏 FSRS 计算的操作。
- **它并不解决卡片数量膨胀。** Anki 提供的是批量管理界面，不是入库门槛；洪水照样发生。

补充事实：Anki 的 FSRS 截至目前仍非默认开启，需逐 deck 打开；而 `ts-fsrs` 实现 FSRS-6、参数与 Anki 同源同序。所以「借 Anki 获得 FSRS」并非我们缺失的能力。

## Consequences

- 卡片、调度状态与复习记录都存于业务库（ADR-0004），调度由 `ts-fsrs` 计算（ADR-0003）。参数与 Anki 的 FSRS-6 可映射，日后要互操作不至于无路可走。
- 放弃现成的卡片管理界面、Anki 手机端与 AnkiWeb 同步。卡片管理界面需自建，但我们本就要做 Web UI，其边际成本低于上述运行时依赖。
- 手机端复习若成为真实需求，以单向导出 apkg 提供，属可选便利而非架构依赖。需注意导出后在 Anki 中的复习是自评的，不产生 AI 评价记录。
