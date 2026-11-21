# OpenStax 与 Google Research 阅读实测

2026 年 11 月 21 日，使用独立的 DSH 主机、Chrome 用户目录和 Obsidian 测试库。截图在 1440 × 940 和 390 × 844 CSS 像素的视口下采集。

## OpenStax《Principles of Finance》

把 `/pages/` 地址粘贴进资料库，点击 *Open book*。阅读器使用出版社书目提供的入口，打开第一章的 *Why It Matters*，并按出版社原有分组显示 261 节。使用下一节、上一节和目录跳转，验证了 1.1、1.2、2.1 和 19.1。浏览器扩展打开 1.3 后，再从地址打开同一节，得到相同的书籍和节次。[OpenStax 书籍入口](https://openstax.org/books/principles-finance/pages/)、[出版社书目信息](https://openstax.org/apps/cms/api/books/principles-finance/)

| 操作 | 阅读器主机发出的章节 HTML 请求 |
| --- | --- |
| 第一次打开书籍入口 | 1 次，第一章 *Why It Matters*。另有 2 次书目 JSON 请求，其中 1 次来自重定向 |
| 打开下一节 1.1、目录中的 1.2 和第 2 章的 2.1 | 各 1 次，只请求目标节 |
| 从 1.2 直接跳到目录第 238 节 19.1 | 1 次，只请求 19.1，中间章节 0 次 |
| 在扩展中打开此前未读的 1.3 | 1 次，只请求 1.3 |
| 回到已缓存章节、重新打开书籍和跟随笔记回链 | 0 次 |

计数来自阅读器主机的 HTTP 请求事件。完整日志记录了章节 HTML、书目信息和插图请求。[真实站点请求记录](live-publisher-requests.json)

滚到 1.2 的 “Financial planning is critical” 段落并关闭 Chrome。新 Chrome 用户目录从资料库打开书籍时，恢复到同一段落 `p-12`。关闭前与重开后，该段落开头都位于阅读区顶部下方 35.6 CSS 像素。随后粘贴 1.1 的独立地址，阅读器切换到指定节。[恢复位置数据](live-vault-and-resume.json)、[桌面续读](live-book-resume-desktop.png)、[390 像素续读](live-book-390.png)

在 1.1、1.2 各留一条摘录笔记，两条都出现在同一章的 Markdown 中。在 2.1 保存笔记时，阅读器写入第 2 章的文件。阅读器的 Obsidian 按钮指向测试库中的实际文件。

- `Paper Reader/principles-finance/1 Introduction to Finance.md`
- `Paper Reader/principles-finance/2 Corporate Structure and Governance.md`

在安装的 Obsidian 中从书籍文件夹打开第一章 Markdown，并点击其渲染出的回链。测试捕获点击的地址，在隔离 Chrome 中打开它，定位到 1.1 的摘录。章内 1.2 的来源按钮也从 1.1 跳回对应段落。[阅读器章节笔记](live-book-chapter-desktop.png)、[Obsidian 章文件](live-obsidian-chapter.png)

## Google Research 文章

用网页地址和 Chrome 扩展分别打开原文。阅读器保留标题、导语、8 张图和 9 段图注，目录可跳到 *Introducing WikiProfile* 和 *Why does recall fail?*。两处图表在 Chrome 中完成解码并通过像素检查，图注与替代文本关联。文章正文排除了站点导航和推荐文章。保存摘录笔记后，点击来源可以回到 “recall becomes harder” 并高亮选中文字。[Google Research 原文](https://research.google/blog/empty-shelves-or-lost-keys-recall-is-the-bottleneck-for-parametric-factuality/)、[桌面笔记回链](live-google-note-desktop.png)、[390 像素原站图表](live-google-390.png)

## 复测

先运行 `npm run build`。`npx --no-install tsx tests/e2e/book-reading.ts` 使用回环测试站完成两条流程。追加 `--live --evidence` 后访问公开原站并生成这份报告引用的证据。
