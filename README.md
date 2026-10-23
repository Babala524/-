# 绯羽 FeatherPanel

饥荒联机版服务器管理面板，支持 Ubuntu / Debian 原生部署与 Docker 部署。

## 原生快速部署

在云服终端执行，自动下载发布包、校验并安装。需已有 curl；没有时先执行 `sudo apt-get update && sudo apt-get install -y ca-certificates curl`。

```bash
curl -fL --proto '=https' --proto-redir '=https' https://github.com/Babala524/-/releases/latest/download/install-online.sh -o feather-install-online.sh && sudo bash feather-install-online.sh
```

此入口需要仓库中存在已发布的 Release 及安装附件。支持 x86_64 Ubuntu 22.04/24.04、Debian 12/13，要求 systemd。默认直接监听内网 TCP 80，不需要 Docker 或 Nginx；NAT 云服把公网端口转发到内网 80。每层世界的直连 UDP 端口在房间设置填写。80 已被占用时追加 `--port 18081`。

安装完成后打开面板，在首次初始化页面创建管理员账号。查看初始化密钥：

```bash
sudo featherpanel key
```

创建成功后初始化密钥删除，账号密码以哈希保存。默认关闭公开注册。游戏服务端需在面板的“更新游戏”中下载。

离线取得发布包后也可以解压执行 `sudo bash install.sh`。安装脚本依赖联网访问软件源、Node.js 和 Valve；已有 Docker 实例与数据不会自动迁移。详情：[原生部署与更新](docs/native-deployment.md)、[安全与账号](docs/security.md)。

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

在项目根目录运行 `python3 scripts/package-release.py`，生成 `dist/install-online.sh`、`dist/FeatherPanel-native.tar.gz`、`dist/FeatherPanel-native.tar.gz.sha256`。测试通过后将这三个文件上传到同一个 GitHub Release，在线入口会下载最新正式版本。

当前 Linux 156 项后端测试通过。Ubuntu 24.04 与 Debian 12 隔离安装、重复安装及启停验证通过；真实 systemd 开机启动与完整原生开服尚未实测，Ubuntu 22.04 / Debian 13 尚未实机验证。第三方游戏、模组和网络故障无法保证不会发生，应定期备份。

## 第三方许可与素材

本项目使用部分 DMP MIT 授权代码与 luaparse，并保留许可证和署名，见 [第三方说明](THIRD_PARTY_NOTICES.md) 及 `licenses/`。游戏、模组图标、用户提供的壁纸和设计属于其各自权利人；第三方代码许可不代表获得这些素材的再分发授权。
