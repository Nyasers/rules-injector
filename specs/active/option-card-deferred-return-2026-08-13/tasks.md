# Tasks — option-card 回传改走 deferred 通道

## T1 routes/card.js POST /card/choose：session:send → deferred 通道
- 描述：choose 成功路径改走 `deferred:register`（taskId=`oc-<cardId>-<ts36>`，sessionPath 取库中 p 或 body 回退，meta={type:"rules-injector", label:"选项卡片回传", deliveryIntent:"trigger_parent_turn"}）+ `deferred:resolve`（result=回传文本）；移除 `session:send` 与 `sendWithBusyRetry`/`BUSY_RETRY_DELAYS`；resolve 成功后才 markCardConsumed；register/resolve 失败返回 `{ok:false,error}` 不标记消费
- 关联 AC：回传走 deferred / 三种模式文本不变 / 消费标记时机 / busy 托管 / 移除自研重试 / register 失败语义
- 允许修改：`routes/card.js`
- 完成标志：逻辑层模拟注册+resolve 调用序列正确；失败路径不标记消费

## T2 routes/card.js：降级落地（已定方案 B：直接报错）
- 描述：register 失败（宿主不支持 deferred / 会话信息缺失）直接返回 `{ok:false,error}`，不标记消费，不保留 session:send fallback；客户端显示「发送失败」，卡片不锁定可重试（与规则注入同策略）
- 关联 AC：register/resolve 失败语义
- 允许修改：`routes/card.js`
- 完成标志：模拟宿主不支持 register 时返回错误且不标记消费

## T3 tools/option-card.js：工具描述微调（回传角色说明）
- 描述：description 中「自动作为一条消息发回当前会话」补充后台投递语义（消息角色 = 后台事件，模型可见界面隐身）；识别契约（`（选项卡片）<q>` 前缀格式）不变
- 关联 AC：无（文档性）
- 允许修改：`tools/option-card.js`
- 完成标志：描述与实现一致，Agent 侧识别契约零改动

## T4 测试：逻辑层 + 真实宿主验证
- 描述：`_tmp/tests/` 下 node 脚本模拟 choose 调用序列（deferred:register/resolve 参数、taskId 唯一性、失败路径不标记消费）；真实宿主验证：点选 → agent 收到 hana-background-result 消息（模型可见 UI 隐身）→ 历史无伪造用户消息 → busy 场景（流式输出中点击）→ 卡片即锁定、agent 空闲后自动收到 → 自定义/跳过两模式
- 关联 AC：真实宿主实测 / busy 场景 / 三模式 / 无伪造用户消息
- 允许修改：`_tmp/tests/`、插件安装目录
- 完成标志：逻辑层全绿 + 真实宿主 busy 与常规路径全通

## T5 打包 + 文档 + 归档
- 描述：scripts/build-release.py 打包 0.8.10 → 解压覆盖；README changelog 0.8.10 记录回传改道（含 UI 隐身行为变更说明）；SPECS.md Active→Completed；spec 归档 archived/
- 关联 AC：版本 0.8.10
- 允许修改：releases/、README.md、SPECS.md、specs/
- 完成标志：文档闭环、release 产物自校验通过
