# SISSO-Sage

[English](README.md) | [简体中文](README.zh-CN.md)

SISSO-Sage 帮助 AI 老师检查已经完成的 SISSO 计算，并从中找出几条有科学依据的候选公式。普通用户不需要学习工具命令，也不需要理解内部评分规则。

## 如何使用

1. 下载本项目：

   ```bash
   git clone https://github.com/chen121760/SISSO-Sage.git
   ```

2. 将 SISSO 输出数据和特征提取代码放在 AI 老师能够读取的位置。例如：

   ```text
   我的研究项目/
   ├── SISSO-Sage/
   ├── sisso-run/
   │   ├── train.dat
   │   ├── verify.dat              # 可选
   │   ├── Models/
   │   └── SIS_subspaces/
   └── feature-extraction/
       └── 特征提取脚本
   ```

3. 用 AI 编程助手打开这个目录，然后直接告诉它：

   > 请使用 SISSO-Sage 分析 `sisso-run`。特征提取代码位于
   > `feature-extraction`。

后续命令由 AI 老师自行执行。必要时，它会查看 feature metadata 和特征提取源码；如果无法可靠确定某个 feature 的含义，它会向你询问，而不是自行猜测。

## 你会得到什么

- SISSO 输出和留出数据是否可靠；
- 多条值得进一步研究的候选公式，而不是一个自动指定的“最佳公式”；
- 预测性能和数学定义域检查；
- 每条公式为什么可能具有或不具有科学意义；
- 哪些结论仍缺少证据，需要研究者确认。

SISSO-Sage 不会自动把某条公式宣布为物理规律。最终的物理解释仍然需要研究者判断。

## 配套工具

如果希望在浏览器中查看图表、表格和 Pareto 前沿，可以使用
[SISSO-Analyzer](https://github.com/chen121760/SISSO-Analyzer)。Analyzer 适合可视化和人工探索，
Sage 适合让 AI 老师进行证据审查。二者相互独立，但可以分析同一份 SISSO 结果，配合使用。

## 环境与隐私

只需要 Node.js 18 或更高版本。默认分析在本地运行，不会上传你的数据。

可选的 Jev 全量语义评价会将公式证据发送到 TypeSafe API，提供多维评分、
断点续跑和候选审查报告。申请 API 与使用方法见 [Jev 指南](docs/JEV.zh-CN.md)。
评分标准仍需研究者校准，最终公式解释由 AI 老师和研究者完成。

AI 工作流程详见 [AI_GUIDE.md](AI_GUIDE.md)，开发与版本变化记录在 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Apache License 2.0，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
