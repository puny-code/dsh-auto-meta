# dsh-auto-meta

给自定义 provider 的模型一键补全真实参数：在「设置 → 模型」里，每个模型行多一个「自动填写」图标按钮，
点一下就从 [OpenRouter 模型目录](https://openrouter.ai/api/v1/models) 里查出这个模型的实际参数，填进该行。

## 为什么需要它

DSH 的模型元数据（上下文长度、输出上限、输入模态、思考等级）只对内置 provider 目录里的模型生效。
自己接入的第三方 provider 不在目录里，这些字段就全部落到默认值——上下文 262144、输入只有 text、
思考档位菜单不出现——哪怕模型名字是 `deepseek-v4.1-flash` 这种有明确公开参数的模型。

## 为什么以 OpenRouter 为准

第一版用的是 models.dev。它收录的是「各家转发商各自声明的值」，对同一个模型往往互相矛盾：
`deepseek-v4.1-flash` 在 models.dev 里由 20 多家转发商收录，取值各不相同（有的 `low/medium/high`，
有的 `low/high/max`，有的 `none/low/high/max`），而 **deepseek 官方 provider 名下并没有这个模型**，
于是只能取多数派，得出一组谁都没声明过的档位。

OpenRouter 的目录是模型方直接声明的：`deepseek/deepseek-v4.1-flash` →
`supported_efforts: max / high / low / none`、`context_length: 1048576`、
`max_completion_tokens: 943718`、`input_modalities: text + image`。这正是它该有的参数。

models.dev 仍然保留，但**只当补字段的兜底**：OpenRouter 未收录（例如 `kimi-for-coding` 这类只对特定
客户端开放的模型）或某个字段缺失时，才去 models.dev 取那一个字段，永远不会用它的档位覆盖
OpenRouter 的声明。

## 行为

- **只写在草稿里，不替你保存**：填入的是该行可见输入框的值，走的是和手打完全相同的解析路径。
  确认无误后点编辑器里的「保存」才会落盘。这样不会把设置页的 revision 顶掉，也不会在你不想要时改动配置。
- **不猜**：只填目录里明确声明的字段。没有声明思考档位的模型（例如 `mimo-v2.6-flash`）不会凭空多出档位。
- **匹配不出时不硬凑**：按钮变橙色，把鼠标停在上面会提示原因（两个目录都未收录 / 该行没有可填项 / 模型 ID 为空）。
- **会覆盖你的手填值**：按钮是显式的「以目录为准」，点它就是让这一行回归目录数据；不想改就别点。
- **首个点击会联网**：从 OpenRouter 拉一次（约 790 KB），清洗后存进浏览器 IndexedDB，24 小时内不再请求；
  网络失败时退回旧缓存，旧缓存也没有才提示获取失败。models.dev 只在需要补字段时才惰性拉取，且失败不报错。
- **不挤掉删除按钮**：模型行原本是四轨网格，多一个按钮会换行把删除按钮压到第二行。插件检测到行溢出时
  把该行改成单行 flex，多出的宽度由两个输入框按原比例分摊。

## 匹配：先精确，再别名，再模糊

OpenRouter 的 id 形如 `vendor/model`，同一模型还有快照与变体（`...-20260910`、`:batch`、`:free`）。
清洗时按叶子名归一（去 `vendor/`、去 `:变体`、去 `-20260101` 形式的快照后缀），同一叶子的多条记录里
优先取非变体、再取最新、再取 id 最短的一条。

| 级别 | 条件 |
| --- | --- |
| exact | 叶子名完全相同（同拼写优先，避免被最新快照抢走） |
| canonical | 命中 `canonical_slug`，例如 `glm-5.2` → `z-ai/glm-5.2-turbo` |
| fuzzy | 名字相似度 ≥ 0.8（bigram Dice；一方是另一方的前缀则直接 0.9），例如 `deepseek-v4.1-flash-fast` |

三级都不中 → 转 models.dev 兜底；仍不中 → 提示未收录。模糊命中会在按钮提示里标明「按 X 模糊匹配」。

## 填什么

| 行内字段 | OpenRouter | models.dev 兜底 |
| --- | --- | --- |
| 上下文窗口 | `context_length` | `limit.context` |
| 最大输出 token 数 | `top_provider.max_completion_tokens` | `limit.output` |
| 输入类型（文本 / 图片） | `architecture.input_modalities` | `modalities.input` |
| 思考档位与线缆值 | `reasoning.supported_efforts`（`none` → 该页面的「关闭」档） | `reasoning_options` 的 `effort` |

思考档位只在页面已经渲染出这一区域时才会被填（页面只为自定义 route 的模型显示该区域）。

## 安装

```bash
dsh plugin --profile <profile> add https://github.com/puny-code/dsh-auto-meta/releases/download/v0.3.0/dsh-auto-meta-0.3.0.tgz
```

本地开发时也可以直接指目录：

```bash
dsh plugin --profile <profile> add <本目录绝对路径>
```

## 开发

```bash
node --test test/client.test.mjs
```

实现是单个 `client.js`：纯逻辑（清洗、匹配、推导、档位计划）集中在文件前半部分并挂在 `__pure` 上供测试，
DOM 注入在文件后半部分。注入用 MutationObserver 找到每个 `modelEntry`，把按钮插在「模型选项」按钮左侧，
幂等（按钮自带 `data-dsh-auto-meta` 标记），并在 rAF 里执行以免观察到自己造成的变更。
`test/fixtures/openrouter-deepseek-v4.1-flash.json` 是从线上抓下来的真实记录，用于锁定
`none/low/high/max` 这条回归。
