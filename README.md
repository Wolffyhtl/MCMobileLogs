# 🪓 Minecraft-Mobile 日志分析器

一个为 **Minecraft 安卓 / iOS 启动器日志**设计的智能分析工具，支持自动提取基础信息、快速匹配崩溃原因，并提供 AI 智能分析🌟

此为netlify部署版本，修改自[Web-MinecraftLogAnalyzer](https://github.com/LanRhyme/Web-MinecraftLogAnalyzer)

## 🚀 快速开始

### 点击此按钮将可以一键将本项目部署至自己的nitlify
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/LanRhyme/Web-MinecraftLogAnalyzer-Netlify)

### 如果一键部署失败请尝试手动部署

1. fork本项目到自己的GitHub账号
2. 登录 [Netlify](https://app.netlify.com/) 账号
3. 点击 **New site from Git** 按钮
4. 选择 **GitHub** 作为部署来源
5. 选择刚才fork的仓库
6. 配置全部默认，环境变量之后设置
7. 点击 **Deploy site** 按钮开始部署

### 配置环境变量
在netlify中配置环境变量

项目主页 -> Project configuration -> Environment variables -> Add a variable

选择Import from a .env file进行快速配置

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_PROXY_TARGET=https://generativelanguage.googleapis.com/
CUSTOM_KEYWORDS=sodium|iris|xaero|customskinloader
```

### 各个环境变量的描述
> * GEMINI_API_KEY为你的Google Gemini AI API密钥，获取方式请参考[Google Gemini AI 文档](https://aistudio.google.com/app/apikey)。

> * GEMINI_PROXY_TARGET=https://generativelanguage.googleapis.com/
>
> 这个为为Gemini AI API的代理地址，默认是谷歌官方的，因为部署在netlify上所以保持默认即可
>
> 推荐项目：[https://github.com/antergone/palm-netlify-proxy](https://github.com/antergone/palm-netlify-proxy)

> * CUSTOM_KEYWORDS为检测关键词当日志分析器检测到日志中存在这些关键词时就会发出警告，使用 `|` 进行分隔，默认值为 `sodium|iris|xaero|customskinloader`，可以根据需要修改


## 📫 联系我
欢迎访问个人主页 👉 [https://lanrhyme.netlify.app/](https://lanrhyme.netlify.app/)

或通过 GitHub 提交 Issue！

## ⭐ Star 一下吧！
如果你觉得这个项目有帮助，欢迎点个 ⭐ Star！

