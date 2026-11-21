# 侧边栏目录实测

2026 年 11 月 21 日，在 Chrome 桌面和 390 × 844 的窄屏视口验证。

| 读者操作 | 观察到的结果 |
| --- | --- |
| 打开 OpenStax《Principles of Finance》，一边读一边看目录 | 当前章展开，当前小节标亮。查看全书 261 个目录项没有触发额外正文下载。从 1.2 跳到 19.1 只下载 19.1。重开书籍，目录与上次读到的段落一致。[书籍侧栏截图](../books-and-blog/live-book-resume-desktop.png) |
| 在 Google Research 博客里点小标题，再往回滚 | 点击跳到对应标题，往回滚时侧栏随正文标亮上一节。另在 arXiv HTML 和 Go Blog 验证了标题跳转。[网页阅读实测](../books-and-blog/ACCEPTANCE.md) |
| 在带书签的 PDF 里打开同一页靠下的小节 | 阅读器保留书签层级和页内位置。刷新后正文和侧栏仍指向选中的小节，模型请求为 0。[原生 PDF 书签](native-pdf-desktop.png) |
| 在手机宽度下打开目录并选节 | 目录从底部展开，选好后收起并回到正文。按 Esc 关闭时焦点回到入口。生成过的 PDF 目录在新 Chrome 配置里也能打开。[窄屏目录](cached-pdf-390.png) |

## 真实模型生成 PDF 目录

从公开的 16 页 PagedAttention 论文副本中移除书签，保留每页原文，再用本机已连接的模型生成目录。此次得到 33 项，覆盖原有 32 个书签标题，另识别了第 14 页的致谢。点击「4.1 PagedAttention」到达第 5 页，刷新后该项仍标亮。[生成结果和原书签对照](live-model-outline.json) · [实际阅读画面](live-pdf-ai-zh.png)

独立复核另用受控模型返回一个不存在的原文位置。阅读器提示重试，重试成功后才保存目录。对只有图像的扫描件，阅读器提示先做 OCR，两种情况都未写入空目录。[重试画面](pdf-generation-retry.png) · [扫描件提示](scan-no-text-390.png)
