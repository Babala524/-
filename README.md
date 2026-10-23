# 绯羽 FeatherPanel

饥荒联机版服务器管理面板，支持 Ubuntu / Debian 原生部署与 Docker 部署。

## 原生快速部署

在云服终端执行，打开部署管理菜单，再选择“1. 安装面板”。需已有 curl；没有时先执行 `sudo apt-get update && sudo apt-get install -y ca-certificates curl`。

```bash
curl -fL --proto '=https' --proto-redir '=https' https://github.com/Babala524/-/releases/latest/download/install-online.sh -o feather-install-online.sh && sudo bash feather-install-online.sh
```

GitHub 直连较慢时，可选择第三方下载加速入口：

```bash
curl -fL --proto '=https' --proto-redir '=https' https://gh-proxy.com/https://github.com/Babala524/-/releases/latest/download/install-online.sh -o feather-install-online.sh && sudo bash feather-install-online.sh
```

菜单提供安装、更新、启停、状态、日志、初始化密钥及环境检查。下载线路可以选择自动切换、GitHub 直连、gh-proxy.com 或 ghfast.top，下载显示进度，失败会重试。加速服务是第三方服务，仅用于公开发布文件，不保证持续可用；可选择直连。安装后运行 `sudo featherpanel` 再次打开菜单，直接更新可用 `sudo featherpanel update --line auto`。

支持 x86_64 Ubuntu 22.04/24.04、Debian 12/13，要求 systemd。默认直接监听内网 TCP 80，不需要 Docker 或 Nginx；NAT 云服把公网端口转发到内网 80。每层世界的直连 UDP 端口在房间设置填写。80 已被占用时在菜单输入其他端口。无人值守安装追加 `--install`，指定端口再追加 `--port 18081`。

部署包自带经摘要校验的 Node.js，首次部署先启动面板。Python、Pillow、screen、字体和游戏运行库在首次使用存档、地图或游戏功能时自动安装；已有依赖直接复用。缺少证书、tar、xz 或端口检查等基础工具时，仍需从系统软件源补齐。

安装完成后打开面板，在首次初始化页面创建管理员账号。查看初始化密钥：

```bash
sudo featherpanel key
```

创建成功后初始化密钥删除，账号密码以哈希保存。默认关闭公开注册。游戏服务端需在面板的“更新游戏”中下载。

离线取得发布包后也可以解压执行 `sudo bash install.sh`。首次使用相关功能需要访问软件源及 Valve；已有 Docker 实例与数据不会自动迁移。详情：[原生部署与更新](docs/native-deployment.md)、[安全与账号](docs/security.md)。

## 功能

- 房间、多层世界配置及可视化 / Lua 编辑，世界预设、公告与自动化。
- Steam 创意工坊搜索、并发下载、模组配置、预设与更新通知。
- ZIP 存档导入导出、备份、快照及恢复保护。
- 各世界游戏日志、聊天日志、日志分析与玩家管理。
- 基于存档和本机游戏素材绘制地图，支持扩展世界素材。

Docker 部署见 [后端与部署说明](backend/DEPLOY.md)。

## 开发与发布

后端使用 Node.js 24 内置 HTTP / SQLite，Python 3 和 Pillow 处理存档与地图；Linux 使用 screen 管理游戏世界。无需 npm 第三方依赖。

```bash
cd backend
node --test test/*.test.mjs
```

在项目根目录运行 `python3 scripts/package-release.py --version v2026.10.23.2`，构建时从 Node.js 官方获取固定版本并验证 SHA-256，再打入完整部署包。生成 `dist/install-online.sh`、`dist/FeatherPanel-native.tar.gz`、`dist/FeatherPanel-native.tar.gz.sha256`、`dist/release-info.json`。将四个文件发布到同标签的 GitHub Release。生成的入口内置版本与包摘要，首次安装无需查询 GitHub API；更新时读取 Release 中的版本信息，沿所选下载线路请求。

Linux 后端与按需依赖测试已通过。Ubuntu 24.04 与 Debian 12 隔离安装、重复安装及启停验证通过；真实 systemd 开机启动与完整原生开服尚未实测，Ubuntu 22.04 / Debian 13 尚未实机验证。第三方游戏、模组和网络故障无法保证不会发生，应定期备份。

## 第三方许可与素材

本项目使用部分 DMP MIT 授权代码与 luaparse，并保留许可证和署名，见 [第三方说明](THIRD_PARTY_NOTICES.md) 及 `licenses/`。游戏、模组图标、用户提供的壁纸和设计属于其各自权利人；第三方代码许可不代表获得这些素材的再分发授权。
