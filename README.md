# dsh-zotero

`dsh-autoresearch` 工作台的**外部通道 helper**，从 preset 里拆出来独立成包。它提供本地 Zotero、
arXiv、书目 REST、索引发现与期刊分区五条通道，形态全部是**命令行程序**——`node <cliToolsDir>/x.mjs`。

## 零常驻

这个包**不挂载任何 DSH 工具**。它没有 `cordis.patch.yml`，不在 `ctx.tools` 里注册任何东西，
所以一个不调用它的请求，为它付出的 context 是 0。

模型怎么知道它存在：preset 的 discipline 技能正文里写了命令与用法（`{{presetTools}}` token 在
技能注册时被填成本包的绝对 `tools/` 目录）。发现路径是 skill 描述 → 技能正文 → `--help`，
不是工具列表。

> 与 npm 上的 `dsh-zotero` 无关：那个是另一套实现（16 个常驻工具 + Sources 面板），本包是
> `@beibingyangliuying/dsh-zotero`，两者可以并存。

## 被 preset 消费的方式

```js
// 解析本包的目录，而不是猜安装位置或翻 profile 的 node_modules
const { cliToolsDir } = await import(new URL(
  import.meta.resolve('@beibingyangliuying/dsh-zotero/tools-dir'),
))
// cliToolsDir -> "D:/.../dsh-zotero/tools"
```

`exports` 里显式声明了 `./tools-dir` 与 `./tools/*`；不声明就 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

## helper

| 文件 | 用途 |
|---|---|
| `zotero-read.mjs` | 检索、读条目、全文切片、合集与标签 |
| `zotero-write.mjs` | 新增条目（DOI / arXiv），默认 dry run |
| `zotero-edit.mjs` | 字段与标签编辑 |
| `zotero-remark.mjs` | 批注与 remark |
| `zotero-section-note.mjs` | 分节笔记（最大的一块） |
| `zotero-collection.mjs` | 合集管理 |
| `zotero-export.mjs` | 引用格式化与导出 |
| `zotero-pdf.mjs` | PDF 大纲、抽取与渲染 |
| `zotero-link-attachments.mjs` | 附件链接 |
| `zotero-ensure.mjs` | 启动 / 探测本地 Zotero |
| `zotero-local-api.mjs` | 本地 API 共享层（不是入口） |
| `arxiv.mjs` | arXiv 检索（自己的查询语法） |
| `metadata.mjs` | 书目 REST：标识符、venue、计数 |
| `scholarly.mjs` | 多索引融合发现 |
| `scholarly-read.mjs` | 开放获取全文读取 |
| `scholarly-sources.mjs` | 来源枚举 |
| `journal-rank.mjs` | 期刊分区 |
| `refusal.mjs` | 共享失败输出（不是入口） |

`tools/owner/zotero-link-snippet.js` 是给 Zotero 端用的脚本片段，不在这里执行。

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
