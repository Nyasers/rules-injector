---
name: rules-manager
description: "管理 rules-injector 插件的文件化行为规则：列出/读取/新建/修改/删除/开关规则、恢复内置默认、排查规则注入不生效。触发场景：管理规则、新建规则、修改规则、改规则内容、开关规则、禁用规则、启用规则、恢复规则默认、规则注入、行为规则、规则面板操作、规则文件操作、规则不生效排查。遇到任何与 rules-injector 规则增删改查相关的需求，使用本技能直接操作数据目录工作副本。"
---

# 规则管理（rules-injector）

本技能用于管理 **rules-injector** 插件的文件化行为规则。与侧边栏「规则」面板完全等价：操作同一份数据目录工作副本（唯一事实源），改动后用户下一条消息提交时按最新清单注入。

## 数据布局（必须先理解）

```
%USERPROFILE%\.hanako\plugin-data\rules-injector\
├── data.db            # 注入指纹 / 卡片消费 / 全局开关（状态，勿手改）
└── rules\             # 工作副本 = 唯一事实源
    ├── builtin\       # 内置规则工作副本（种子播种双向同步：升级不覆盖用户改动，种子下架的规则降级到顶层自编区）
    │   ├── xxx.md     # 启用
    │   └── xxx.mdisabled  # 禁用（改名即开关）
    └── xxx.md         # 用户自编规则（顶层，默认语义优先于同名 builtin）
```

- 规则 key = 文件名去扩展名（`.md` / `.mdisabled`），文件名即标题，首行 `# 标题` 自动对齐
- 开关 = 扩展名：`.md` 启用 ↔ `.mdisabled` 禁用（原子改名）
- 内置种子只读（插件目录 `%USERPROFILE%\.hanako\plugins\rules-injector\rules\`）；用户改过的工作副本保留；种子下架的内置规则：已自定义过（顶层有同名自编）→ 直接删除旧副本，未自定义过 → 降级到顶层自编区并默认禁用（归属变自编）
- 内置规则自定义 = 新建同名自编规则覆盖（优先级高于内置），开关态跟随内置；恢复默认 = 删除根的副本，开关状态保持；被自定义过的内置规则开关时内置副本与顶层覆盖两处同步

## 运行环境

Node 由 fnm 管理、不在 PATH 时，先取本机 fnm 的 node 路径（`fnm exec -- node -v` 可确认）；node 在 PATH 时直接使用即可。示例中的 `$node` 请按实际环境替换，勿照抄。

本技能随 rules-injector 插件分发（插件包内 `skills/rules-manager/`），安装后位于：

```
%USERPROFILE%\.hanako\plugins\rules-injector\skills\rules-manager\
```

```
插件根（安装于 %USERPROFILE%\.hanako\plugins\rules-injector\）
├── cli.mjs                     # 规则管理 CLI（参数解析 + action 分发，与 lib 同层）
├── lib\rules-fs.js             # 文件化规则：播种 / 扫描 / 开关（单一事实源）
└── skills\rules-manager\SKILL.md  # 本技能说明
```

CLI 与 lib 同层相邻，无跨层路径。

## 用法

```
node cli.mjs <action> [选项]
action: list | get | create | update | delete | toggle | restore
选项:
  -n, --name <名>             规则名
  -c, --content <文本>        规则全文（create/update）
  -f, --content-file <路径>   从文件读全文（多行内容推荐，与 -c 互斥优先）
  -e, --enabled <true|false>  toggle 目标状态
  -d, --dataDir <路径>        数据目录（默认平台插件数据目录，一般不用传）
  -s, --seedDir <路径>        种子目录（默认平台插件目录，一般不用传）
```

### 各 action 示例（PowerShell）

```powershell
# node 在 PATH 时直接使用；否则替换为 fnm 实际路径
$cli  = "$env:USERPROFILE\.hanako\plugins\rules-injector\cli.mjs"

# 列出所有规则（含禁用）
& node $cli list

# 读规则全文
& node $cli get -n "卡片收尾规则"

# 新建自编规则（多行内容先写临时文件）
Set-Content -Path "$env:TMP\rule.md" -Value "# 标题`n- 要点一`n- 要点二" -Encoding utf8
& node $cli create -n "新规则名" -f "$env:TMP\rule.md"

# 更新自编规则
& node $cli update -n "新规则名" -f "$env:TMP\rule.md"

# 删除自编规则
& node $cli delete -n "新规则名"

# 开关（内置/自编均可）
& node $cli toggle -n "新规则名" -e true

# 恢复内置规则默认（工作副本回归种子版）
& node $cli restore -n "卡片收尾规则"
```

> content 也可以直接 `-c` 传，但多行内容在命令行里易被引号/换行坑，**推荐 `-f` 文件方式**。

## 语义与注意

- **顶层优先**：自编规则与 builtin 同名时，顶层覆盖内置（合并进清单时位置继承）
- **改完即生效于下一条消息**：状态变更不触发即时投递，判定收敛到用户消息提交时；内容未变化的轮次由判据短路，不重复注入
- **指纹**：清单标识 = 生效清单 sha256 前 16 位，内容实质变化才变；新建/开关/修改后不必手动清任何状态，插件自动判定
- **命名**：规则名 ≤48 字符、不含路径分隔符与 `:*?"<>|`；创建即默认启用
- **排查注入不生效**：先 `list` 看规则是否启用（`.md` 存在）；再确认清单内容与预期一致；状态变更是收敛的，等用户下一条消息提交再验证

## 安全边界

- 本技能只读写数据目录 `rules/` 工作副本（`create/update/delete/toggle/restore` 均作用于工作副本，不碰插件种子与代码）
- `restore` 仅内置规则（移除同名自编覆盖 + 内置副本回归种子，开关状态保持）；`delete` 仅自编规则（内置删除 = 恢复默认，走 restore 入口）
- 多行内容写入经 `normalizeHeading` 对齐首行标题，不会破坏文件结构
