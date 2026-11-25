# 部署与在线预览

本项目是 Node.js 服务加原生前端，没有构建步骤。下面三种方式任选一种。

## 1. 本地运行（完整功能）

要求 Node.js 22.17 或更高版本。

```bash
git clone https://github.com/Bryce0312/LLMword.git
cd LLMword
npm ci
npm start
```

打开 <http://127.0.0.1:4174>。服务默认只监听本机回环地址，SQLite 归档写在 `.data/live/`。首次使用在「模型连接」页填自己的模型 API Key；Key 只存在运行中的进程内存里，不写盘。

端口冲突时同时更换端口和数据目录：

```powershell
$env:PORT = '4196'
$env:WORLD_DATA_DIR = '.data/live-b'
npm start
```

## 2. GitHub Codespaces（浏览器里直接用，无需安装）

1. 仓库页点 **Code → Codespaces → Create codespace**。
2. 容器按 `.devcontainer/devcontainer.json` 自动执行 `npm ci` 并在 4174 端口启动服务。
3. 在 **Ports** 面板打开 4174；需要分享时右键端口选 **Port Visibility → Public**。
4. 关闭或删除 codespace 后链接失效，模型 Key 需重新填写。

## 3. GitHub Pages（静态只读展示）

线上地址：<https://bryce0312.github.io/LLMword/>

只包含欢迎页、教程，以及封存模拟运行的回放；新建预测、监听、删除、结算等写操作会被拦截。页面底部有固定说明条，数据不代表真实模型结果。

发布步骤：

```bash
node scripts/build-pages.mjs
```

把 `pages-dist/` 的内容发布到 `gh-pages` 分支，然后在仓库 **Settings → Pages** 选择 `Deploy from a branch`、分支 `gh-pages`、目录 `/(root)`。

构建脚本会改写绝对路径、把 `.mjs` 改名成 `.js`（GitHub Pages 的 MIME 不稳定）、注入回放 shim 和演示说明条。重新抓取回放快照用：

```bash
node scripts/capture-pages-replay.mjs
```

## 需要注意

- 每台机器、每个 codespace 各自一份 `.data/live/`，历史不互通。
- 真实预测需要外网访问模型和信息服务；离线只能看教程与回放。
- 不要把 API Key 写进仓库；仓库只保留 `.env.example`。
