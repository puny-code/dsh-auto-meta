# dsh-auto-meta

给自定义 provider 的模型一键补全真实参数：在「设置 → 模型」里，每个模型行多一个「自动填写」图标按钮，
点一下就从 [models.dev/api.json](https://models.dev/api.json) 里查出这个模型的实际参数，填进该行。

## 为什么需要它

DSH 的模型元数据（上下文长度、输出上限、输入模态、思考等级）只对内置 provider 目录里的模型生效。
自己接入的第三方 provider 不在目录里，这些字段就全部落到默认值——上下文 262144、输入只有 text、
思考档位菜单不出现——哪怕模型名字是 `deepseek-v4.1-flash` 这种 models.dev 里有明确记录的名字。

## 行为

- **只写在草稿里，不替你保存**：填入的是该行可见输入框的值，走的是和手打完全相同的解析路径。
  确认无误后点编辑器里的「保存」才会落盘。这样不会把设置页的 revision 顶掉，也不会在你不想要时改动配置。
- **只填 models.dev 明确声明的字段**：没声明的字段保持原样（例如只有 `toggle` 没有 `effort` 档位的模型，
  不会凭空造思考档位）。
- **匹配不出时不猜**：按钮变橙色，把鼠标停在上面会提示原因（模型未收录 / 该行没有可填项 / 模型 ID 为空）。
- **不覆盖你的手填值？** 会覆盖。按钮是显式的「以目录为准」，点它就是让这一行回归目录数据；
  不想改就别点。
- **首个点击会联网**：首次点击从 models.dev 拉取（约 1.5 MB），压缩后存进浏览器 IndexedDB，24 小时内不再请求。
  网络失败时退回旧缓存；旧缓存也没有则按钮提示参数获取失败。

## 匹配分三级

| 级别 | 条件 | 说明 |
| --- | --- | --- |
| `route` | models.dev 里有同名 provider | 直接用该 provider 自己声明的数据 |
| `vendor` | 靠 `canonical_model_id` 找到厂商官方 provider | 例如 `glm-5.3-flash` → `zhipuai`，`mimo-v2.6-*` → `xiaomi` |
| `consensus` | 同名模型被多个 provider 收录、且没有厂商记录 | 逐字段取多数值（需过半），避免被单个异常 provider 带偏 |

三级都不中 → 提示未收录。

## 填什么

| 行内字段 | 来源 |
| --- | --- |
| 上下文窗口 | `limit.context` |
| 最大输出 token 数 | `limit.output` |
| 输入类型（文本 / 图片） | `modalities.input` |
| 思考档位与线缆值 | `reasoning_options` 里的 `effort` 档位；`none` 映射为该页面的「关闭」档 |

思考档位只在页面已经渲染出这一区域时才会被填（页面只为自定义 route 的模型显示该区域）。

## 安装

```bash
dsh plugin --profile <profile> add https://github.com/puny-code/dsh-auto-meta/releases/download/v0.2.0/dsh-auto-meta-0.2.0.tgz
```

本地开发时也可以直接指目录：

```bash
dsh plugin --profile <profile> add <本目录绝对路径>
```

## 开发

```bash
node --test test/client.test.mjs
```

实现是单个 `client.js`：纯逻辑（匹配、推导、档位计划）集中在文件前半部分并挂在 `__pure` 上供测试，
DOM 注入在文件后半部分。注入用 MutationObserver 找到每个 `modelEntry`，把按钮插在「模型选项」按钮左侧，
幂等（按钮自带 `data-dsh-auto-meta` 标记），并在 rAF 里执行以免观察到自己造成的变更。
