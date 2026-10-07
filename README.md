# dsh-plugin-audit

检查已安装的 DSH 插件是否依赖 **DSH 内部实现细节** —— 这类依赖在 DSH 升级后会「静默失效」：控制台不报错、插件照样加载，但功能整块消失。

典型形态是插件把 DSH 客户端的 CSS Module 哈希类名写死在源码里（`ZTP-Xa_frame`、`nUhMVa_act` 这类）。DSH 每次重建 Web 资源都会整批换前缀，写死的选择器全部失配，而插件本身不产生任何报错。

## 两个工具

| 工具 | 取数方式 | 需要什么 |
|---|---|---|
| `audit-asar.mjs`（推荐） | 直接读桌面端的 `resources/app.asar` | 只要装了桌面端；不需要 DSH 在跑、不需要登录 |
| `audit.mjs` | 从**运行中的 DSH** 抓客户端 bundle | 一个已认证的访问入口（网关状态文件，或 `--base`/`--cookie`） |

asar 里就是内核发给浏览器的同一份客户端 bundle（`window.__ModuleLoader__.load({id, factory})` 格式），所以离线结果与在线等价。

## audit-asar.mjs

```powershell
node audit-asar.mjs --dump [名字]     # 导出当前 DSH 的真实类名快照 → snapshots\*.json
node audit-asar.mjs --audit <基线>    # 审计所有 profile：哪些插件引用了「基线里有、现在没了」的类名
node audit-asar.mjs --diff <旧快照>   # 新旧快照对比：消失的类名 + 旧前缀 → 新前缀映射表
node audit-asar.mjs --check <文件>    # 校验单个文件引用的类名是否仍存在
```

asar 位置按 `DSH_ASAR` 环境变量 / `--asar <路径>` → macOS 默认安装位置依次探测；都找不到时给出显式指引，不抛栈。

```powershell
# 显式指定：路径就是桌面端安装目录下的 resources/app.asar
$env:DSH_ASAR = '<桌面端安装目录>\resources\app.asar'
# 或逐次指定
node audit-asar.mjs --dump --asar '<桌面端安装目录>\resources\app.asar'
```

判据（比 `audit.mjs` 更严，误报更少）：

- 只认「基线快照里存在、当前 DSH 里不存在、且不是插件自身内联定义」的类名 —— 插件自带的 CSS Module 类名（自带前缀、与 DSH 无关）会被自动排除。
- 类名须符合哈希形态：前缀含大写字母、或整个类名带数字、或后缀是驼峰；`node_modules`、`file_path`、`read_image` 这类普通标识符会被排除。

配套的 `remap-classes.mjs` 负责修复侧：

```powershell
node remap-classes.mjs <旧快照> <新快照> <目标文件> [--write 输出.js]
```

它按「**同 CSS Module 源文件 + 同语义后缀**」机械重映射（`ZTP-Xa_frame` → `BynINW_frame`），不需要人工逐个对照。

> 流程闭环：**升级前 `--dump` 一份快照** → 升级后 `--audit 旧快照` 找中招插件 → `remap-classes.mjs` 生成重映射 → `--check` 复核。

## audit.mjs（运行中模式）

```powershell
node audit.mjs                       # 默认检查 desktop profile
node audit.mjs web
node audit.mjs desktop --verbose     # 连无问题的插件也列出来
node audit.mjs desktop --refresh     # 忽略缓存，重新抓取 bundle

# 或显式指定访问入口（任何已认证的 DSH 地址）
node audit.mjs desktop --base https://192.168.1.10:3443 --cookie "dshmo=<token>"
```

没给 `--base` 时，它回落到读 `$DSH_HOME/mobile-access/state.json`（`dsh-mobile-access` 网关开启后写的状态文件）；两者都没有就明确报错并建议改用 `audit-asar.mjs`。抓下来的 bundle 缓存在系统临时目录，重复运行不会重下。

检查项：

| 项 | 说明 | 失效后果 |
|---|---|---|
| 硬编码哈希类名 | 形如 `pI_x6G_frame`、`_bubble_owhem_8` | 选择器全部失配，相关功能静默消失 |
| `[class*="…"]` 结构匹配 | 比硬编码稳，但仍依赖 DSH 保留该语义类名 | 同上，但概率低得多 |
| slot 名 | `slots.register/inject` 的 `name` | 面板/入口不渲染 |
| CSS 变量 | `--dsw-*` / `--dsh-*` | 样式不生效 |

## 局限

- 纯静态比对，只覆盖「插件引用了 DSH 内部标识符」这一类问题。运行时行为差异、host 侧 API 的语义变化不在覆盖范围内。
- slot / CSS 变量两类报出的项，可能只是**插件间的可选依赖**（某个插件找另一个插件提供的 slot），拿不到时插件会走降级路径，属正常设计，需要人工确认。
- `[class*="…"]` 检查会跳过模板字面量、过短的通用词和纯小写词，以减少噪声。
- `--check` 扫的是文件里所有哈希形态的字符串，所以文档性注释里的示例类名也会被算成「引用」；它面向的是插件的 `client.js` 这类真源码。

## 已知案例

- `dsh-mobile-hanui`：0.1.7 时 64 个类名里 53 个失配（整套前缀从 `pI_x6G_*` 换成 `ZTP-Xa_*`），0.2.0-rc.2 时 69 处引用 0 有效（又换成 `BynINW_*`）。两次都表现为「插件正常加载、悬浮按钮不渲染、控制台无报错」，修复只改类名常量，逻辑未动。
- 有些插件引用大量哈希类名，但那是**它们自己内联的 CSS Module**（自带前缀，与 DSH 无关），升级不受影响；`audit-asar.mjs` 的判据会自动排除这类误报。

## 下次 DSH 升级后

```powershell
node audit-asar.mjs --audit snapshots\<升级前的快照>.json
```

若报出批量「引用了当前 DSH 中不存在的类名」，说明又发生了整批改名，用 `--diff` 拿映射表再修。

## 文件

| 文件 | 作用 |
|---|---|
| `audit-asar.mjs` | 离线审计：读 app.asar 导出快照 / 审计 / 对比 / 校验 |
| `audit.mjs` | 在线审计：从运行中的 DSH 抓 bundle，按 profile 检查全部已装插件 |
| `remap-classes.mjs` | 按快照生成类名重映射（修复侧） |
| `snapshots/` | 快照输出目录（本地生成，不入库） |
