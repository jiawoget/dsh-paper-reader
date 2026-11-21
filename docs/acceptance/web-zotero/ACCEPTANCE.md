# 网页阅读与 Zotero 验收

2026 年 11 月 21 日，使用独立的 Paper Reader 数据目录和 Chrome 配置。检查了 1440 × 940 桌面视口和 390 × 844 手机模拟视口。

| 场景 | 实际操作和结果 | 截图 |
| --- | --- | --- |
| [arXiv HTML 论文](https://arxiv.org/html/2404.19737v1) | 在资料库粘贴网址，用目录跳到 Method。原始图 1 加载成功，图片关联图注，公式保留 MathML。 | [图 1 和图注](live-arxiv-figure-desktop.png) |
| [The Go Blog](https://go.dev/blog/slices-intro) | 从真实网页通过 Chrome 扩展打开文章。用目录跳到 Slice internals，核对原文链接、代码块和结构图。保存笔记，从本机文档重开后仍可回到原句。 | [桌面笔记和原句](live-go-blog-note-desktop.png) · [390 px 阅读](live-go-blog-390.png) |
| [Zotero Web 公开条目](https://api.zotero.org/users/475425/items/A52ZIF29?v=3) | 用公开资料库 ID 连接，选中 Zotero techy stuff 并搜索。打开条目后在阅读器中读到 [Creating Bibliographies](https://www.zotero.org/support/creating_bibliographies)，记下 Quick Copy 笔记，从同一 Zotero 条目重开后笔记仍在。 | [桌面资料库](live-zotero-collection-desktop.png) · [390 px 分类和搜索](live-zotero-collection-390.png) · [重开后的笔记](live-zotero-url-note-desktop.png) |
| Zotero Desktop 10.0.8 | 独立原生验收使用临时 Zotero 资料库。从真实桌面程序读取分类和 PDF 附件，并核对打开的 PDF 字节。 | [桌面分类](zotero-desktop-library.png) · [打开 PDF](zotero-desktop-pdf.png) |

本地回归覆盖空库、嵌套分类、搜索无匹配、PDF 附件和笔记，以及 Zotero 离线时从本机文档重新打开笔记。测试服务使用随机端口。公开资料库通过只读请求访问，验收笔记保存在临时 Paper Reader 目录。[PDF 笔记](fixture-zotero-pdf-note-desktop.png) · [离线提示](fixture-zotero-offline-desktop.png)

视觉复核确认 390 px 下搜索和分类选择分行显示，测试分类名称完整可见。桌面 PDF 笔记的 Quote 按钮在较长来源标签旁保持单行。

在 Go 博客的 Slice internals 一节选中切片定义，保存「请用中文解释，并用 a 和 b 举一个例子」后追问。已配置的 deepseek-flash 给出了 `b := a[1:3]` 的例子，并说明改写 `b[0]` 会改变 `a[1]`。[真实提问、笔记和回答](live-go-followup.json)

`npm run test:web-zotero`、`npm run test:web-zotero -- --live` 与 `npm run typecheck` 均通过。[回归与实测脚本](../../../tests/e2e/web-zotero-delivery.ts)
