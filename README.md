# Resume Expert（简历优化专家）

这是一个可本地运行的 AI 简历优化项目，包含用户端八步简历分析流程，以及 Prompt、版本、审核、回归测试、运行监控和质量反馈等管理能力。

## 获取项目

```bash
git clone https://github.com/XY4222/resume-expert.git
cd resume-expert
```

也可以在 GitHub 仓库页面点击 **Code → Download ZIP** 下载源码。

## 环境要求

- Node.js 18 或更高版本
- npm
- DeepSeek API Key（只有调用真实 AI 分析时需要）

## 安装与运行

1. 安装依赖：

   ```bash
   npm install
   ```

2. 复制环境变量示例：

   Windows PowerShell：

   ```powershell
   Copy-Item .env.example .env
   ```

   macOS / Linux：

   ```bash
   cp .env.example .env
   ```

3. 打开 `.env`，至少修改以下配置：

   ```env
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=请设置不少于10位的密码
   ADMIN_SESSION_SECRET=请设置不少于32位的随机字符串
   DEEPSEEK_API_KEY=你的DeepSeek_API_Key
   DEEPSEEK_MODEL=deepseek-chat
   ```

   `.env` 已被 Git 忽略，不要把真实密码或 API Key 提交到仓库。

4. 启动项目：

   ```bash
   npm start
   ```

5. 浏览器访问：

   - 用户端：<http://localhost:4173/>
   - 管理端：<http://localhost:4173/admin>

## 验证项目

```bash
npm test
```

该命令会执行语法检查和完整的业务验证脚本。测试过程使用隔离的临时数据，不需要真实 DeepSeek API Key。

## 常用命令

```bash
npm start   # 启动本地服务
npm run dev # 启动本地服务
npm test    # 执行完整验证
npm run build # 生成部署产物
```

## 数据与安全说明

- 本地运行数据保存在 `data/`，该目录不会提交到 Git。
- 真实密钥只应放在服务端 `.env` 中。
- `dist/`、`data/`、`.env` 和 `node_modules/` 已加入 `.gitignore`。
- `resume-expert-site.tar.gz` 是现有站点部署归档；学习和本地运行请以源码为准。
