# dsh-zotero

本地 Zotero、arXiv、书目 REST、索引发现与期刊分区五条通道，形态是**十五个命令行程序**，外面包一层
**一个** DSH 工具。

## 一个工具，十五个程序

安装后它挂一行（`zotero-channel`），注册**一个**工具 `zotero`：

- 不带参数 → 返回十五个程序各自的用途与一条可照抄的示例；
- 带 `program` + `args` → 用 `execFile` 直接跑那个程序（**不经过 shell**：无需引号、无通配、无管道），
  返回 `exit <code>` 加程序自己的输出。

常驻成本是一个工具 schema（约 150 token/请求），不是十五个。程序本身的参数、拒绝语义与退出码都没有
搬进工具——它们仍属于程序自己。

模型怎么知道它存在：一行 `description` 常驻在工具表里。不调用它的请求不为那十五个程序付费。

> 与 npm 上的 `dsh-zotero` 无关：那个是另一套实现（16 个常驻工具 + Sources 面板），本包是
> `@beibingyangliuying/dsh-zotero`，两者可以并存。

## 两种使用方式

| 场景 | 怎么用 |
|---|---|
| 任何 profile（含标准模式） | 装了本包就有 `zotero` 工具，agent 自己发现 |
| `dsh-autoresearch` 预设 | 该预设的 isolation 屏蔽了本工具，用 discipline 正文里的 `{{presetTools}}/x.mjs` 命令（零常驻） |

preset 用 `import.meta.resolve('@beibingyangliuying/dsh-zotero/tools-dir')` 取 helper 目录；
`exports` 里显式声明了 `./tools-dir` 与 `./tools/*`，不声明就 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

## 安装

```console
dsh plugin --profile web add github:beibingyangliuying/dsh-zotero#v0.2.0
```

它是 `dsh-autoresearch` 的 **peer**（pnpm 不允许 git 解析的子依赖），所以先装它、再装 preset。


## helper

| 文件 | 用途 |
|---|---|
| `zotero-read.mjs` | 检索、读条目、全文切片、合集与标签 |
| `zotero-write.mjs` | 新增条目（DOI / arXiv），默认 dry run |
| `zotero-edit.mjs` | 字段与标签编辑 |
| `zotero-remark.mjs` | 只换 remark 那一行，必须背出旧值 |
| `zotero-section-note.mjs` | 分节笔记（最大的一块） |
| `zotero-collection.mjs` | 合集管理 |
| `zotero-export.mjs` | 引用格式化与导出 |
| `zotero-pdf.mjs` | PDF 大纲、抽取与渲染 |
| `zotero-link-attachments.mjs` | 存储附件转链接附件 |
| `zotero-ensure.mjs` | 启动 / 探测本地 Zotero |
| `arxiv.mjs` | arXiv 检索（自己的查询语法） |
| `metadata.mjs` | 书目 REST：标识符、venue、计数 |
| `scholarly.mjs` | 多索引融合发现 |
| `scholarly-read.mjs` | 开放获取全文读取 |
| `journal-rank.mjs` | 期刊分区 |

三个不对外暴露为程序的模块：`zotero-local-api.mjs`（本地 API 共享层）、`scholarly-sources.mjs`
（来源形状）、`refusal.mjs`（共享失败输出）。`tools/owner/zotero-link-snippet.js` 是给 Zotero 端用的
脚本片段，不在这里执行。

## 开发

```console
npm install
npm test          # 跑 tools/ 下全部 *-selftest.mjs
npm run test:list # 只看会跑哪些
```

测试是离线的：不需要 Zotero 实例、网络或 DSH 在跑。需要外部 I/O 的部分把 I/O 作为参数注入或
拒绝运行。`pdfjs-dist` 与 `@hyzyla/pdfium` 是惰性依赖，只有 `zotero-pdf.mjs` 的渲染路径会用到。

## 许可证

MIT。见 [LICENSE](LICENSE)。
