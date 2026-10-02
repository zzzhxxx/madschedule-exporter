# MadSchedule Exporter

将 UW–Madison 官方 Course Schedule 页面当前显示的课表导出为 **MadSchedule JSON v1** 文件。

A Tampermonkey userscript that exports the currently displayed UW–Madison Course Schedule as MadSchedule JSON v1.

- 保留课程、LEC / DIS / LAB 等组件、每周上课安排、线上授课状态、地点和可见考试。
- 点击后在浏览器本地提取、校验并下载，不发送课表、不添加追踪或分析请求。
- 不导出 NetID、密码、Cookie、认证令牌、Duo 数据或原始网页。
- 无运行时依赖；安装只需要一个 `.user.js` 文件。

本项目为非官方辅助工具，与 UW–Madison 或 Tampermonkey 无隶属关系。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)，并在浏览器中允许扩展运行用户脚本。
2. 打开 [安装 MadSchedule Exporter](https://raw.githubusercontent.com/zzzhxxx/madschedule-exporter/main/mad-schedule-exporter.user.js)，在 Tampermonkey 页面确认安装。
3. 若浏览器显示源码，可在 Tampermonkey 管理面板中新建脚本，粘贴 [脚本文件](mad-schedule-exporter.user.js) 的完整内容并保存。

GitHub 安装链接在脚本上传到公开仓库的 `main` 分支后生效。Greasy Fork 发布后，可通过其脚本页面安装；发布流程见 [发布说明](docs/PUBLISHING.md)。

## 使用

1. 正常登录 [UW Course Schedule](https://mumaaenroll.services.wisc.edu/courses-schedule)，完成 NetID / Duo 验证。
2. 选择需要导出的学期，等待课表完整显示。
3. 点击右下角 **Export for MadSchedule**。
4. 保存下载的 `mad-schedule-<term>.json`，例如 `mad-schedule-fall-2026.json`。
5. 在支持 JSON v1 文件导入的 MadSchedule 版本中导入该文件。

如果当前学期早于页面中最新可选学期，脚本会先提示你确认 MadSchedule 的校历是否覆盖该学期。这个判断来自页面中的学期列表，不依赖写死的年份。

## 范围与限制

- 只导出当前显示的一个学期；切换学期后可再次导出。
- 只在 `https://mumaaenroll.services.wisc.edu/courses-schedule` 及末尾带 `/` 的页面运行。
- 导出采用 JSON v1；不下载或生成 `academicCalendar`，不推测页面未提供的日期范围。
- 空课表的官方页面结构尚未核验，因此脚本会拒绝导出空快照。
- 页面结构变化、课程区域不完整或学期切换未完成时，会停止导出并显示原因。
- 导出文件包含个人课程安排，分享前请自行检查内容。

“本地处理”指脚本的课表提取和下载过程；UW 网页登录、安装脚本及脚本管理器的更新检查仍需要网络。

## 开发与检查

使用 Node.js 22 或更高版本，在本目录执行：

```sh
npm run check
```

无需 `npm install` 或构建。该命令检查脚本语法、运行结构回归测试和发布元信息检查。GitHub Actions 使用 Node.js 24 执行相同命令。

```text
.
├── mad-schedule-exporter.user.js   # 唯一安装 / 发布文件
├── exporter.test.mjs              # 提取、转换、校验回归测试
├── distribution.test.mjs          # 版本、权限、发布地址检查
├── contracts/                    # 自包含的 v1 契约与合成身份向量
├── docs/
│   ├── DEVELOPMENT.md             # 适配逻辑与维护说明
│   ├── PUBLISHING.md              # GitHub / Greasy Fork 发布步骤
│   └── greasyfork-description.md  # 可复制到 Greasy Fork 的介绍
├── .github/workflows/ci.yml
├── package.json
├── CHANGELOG.md
└── LICENSE
```

整个目录可以独立作为 GitHub 仓库；测试不需要外层 iOS 项目。提取逻辑、数据契约及 Swift 互操作说明见 [开发文档](docs/DEVELOPMENT.md)。

## 反馈与许可证

通过 [GitHub Issues](https://github.com/zzzhxxx/madschedule-exporter/issues) 反馈问题，提供浏览器、脚本版本和错误提示即可。请勿上传真实课表、完整网页或认证信息；复现样本应使用虚构数据。

[MIT License](LICENSE)。
