# Ubuntu / Debian 快速部署

解压完整发布包，进入包含 `install.sh` 的目录：

```bash
sudo bash install.sh
```

支持 x86_64 Ubuntu 22.04/24.04、Debian 12/13，要求系统使用 systemd。完整发布包自带独立 Node.js 24，首次部署校验、解压后创建普通服务账号并启动面板。基础工具齐全时不刷新 apt，不安装 Python、screen、字体、游戏运行库，也不下载 SteamCMD。缺少 ca-certificates、tar、xz、iproute2、util-linux 时只补齐缺失工具。直接使用源码且没有随包运行环境时，才单独从 Node.js 官方下载。

首次安装或更新游戏、下载工坊模组时，自动检查 screen 和 32/64 位游戏运行库，缺失时安装，再由普通面板账号下载 SteamCMD；首次存档或模组 ZIP 操作准备 Python，首次地图或上传模组图标准备 Pillow 和字体。已有环境直接复用，不重复刷新软件源。游戏更新任务显示准备运行环境的状态；安装游戏仍需下载游戏文件。

面板维持普通账号权限。依赖服务通过 systemd 本地 socket 按需启动，socket 仅允许 root 和面板组连接；请求只接受 python、map、game 三种固定类型，安装包名及命令由只读程序预设，不接受面板传入路径、Shell 命令或包名。并发请求共享安装锁。失败可重试，查看日志：`sudo featherpanel dependencies`。原生服务依赖 `feather-panel-dependencies.socket`，Docker 不启用此机制。

默认直接监听内网 TCP 80，不要求 Docker 或 Nginx。NAT 云服把自己的公网端口转发到内网 80；每层世界的直连 UDP 端口在面板房间设置中填写。现有服务占用 80 时会中止，可以指定其他内网端口：

```bash
sudo bash install.sh --port 18081
```

可以先只检查环境和端口：

```bash
sudo bash install.sh --check
```

安装完成后，打开公网地址，在登录页创建管理员账号。初始化密钥通过下面的命令查看；创建账号后密钥自动删除：

```bash
sudo featherpanel key
```

常用管理命令：

```bash
sudo featherpanel
sudo featherpanel update --line auto
sudo featherpanel status
sudo featherpanel logs
sudo featherpanel start
sudo featherpanel restart
sudo featherpanel stop
```

`restart` 会先保存并关闭正在运行的世界，重启面板后仅恢复这些世界；停止原生服务会同时停止其管理的游戏进程。游戏没有确认安全关闭时，管理命令报错并停止后续操作。日常开关游戏仍可直接在面板操作。

`start` 在服务停止后启动面板，游戏世界通过面板选择启动；系统重启后 systemd 自动启动的是面板服务。

程序目录为 `/opt/feather-panel-native/current`，数据为 `/var/lib/feather-panel`，设置为 `/etc/feather-panel.env`。账号数据库、存档、模组、游戏文件及 SteamCMD 均在数据目录中；不要删除它。服务名为 `feather-panel.service`。调整环境文件后执行 `sudo featherpanel restart`。无需全局安装 npm 包，不替换系统的 Node.js，不改云厂商端口映射。

更新时解压新版源码，在新版目录再次执行 `sudo bash install.sh`。脚本安装到独立版本目录，在停服前记录原运行世界，保存 SQLite 和旧服务配置，切换程序链接并检查健康；新面板启动失败时尝试切回旧程序，失败信息及备份路径会显示在终端。原生实例更新会短暂停服，游戏进程已存在仅表示进程已启动，是否加载完成仍需查看游戏日志。更新不会清理历史版本与备份。

已有 Docker 实例不会自动迁移。若它占用 80，脚本会拒绝占用该端口；不要直接把正在使用的 Docker 数据卷作为原生服务数据目录。部署到新端口创建的是独立实例。需要迁移时，先停服备份，再单独处理数据路径与文件所属账号。

## 在线拉取安装

已提供 `install-online.sh`，会从指定 GitHub 仓库的 Release 下载完整部署包、核对 SHA-256、检查压缩包路径，再调用原生安装程序。无需在自己电脑下载和上传部署包。首次执行需要云服具备 curl；缺少时先用系统软件源安装 `ca-certificates curl`。

维护者运行 `python3 scripts/package-release.py --version v2026.10.23.2`，将 `dist/` 下的 `install-online.sh`、`FeatherPanel-native.tar.gz`、`FeatherPanel-native.tar.gz.sha256`、`release-info.json` 四个文件上传到同标签的 GitHub Release。入口内置该版本和完整包的 SHA-256，首次下载无需查询 GitHub API；更新时读取 Release 的 `release-info.json`，通过同一条下载线路请求。固定文件名通过 Release 标签区分版本。

项目仓库为 `Babala524/-`，在线入口：

```bash
curl -fL --proto '=https' --proto-redir '=https' https://github.com/Babala524/-/releases/latest/download/install-online.sh -o feather-install-online.sh && sudo bash feather-install-online.sh --repo Babala524/-
```

交互终端运行默认进入菜单，选择安装或更新后可选择下载线路；首次安装可输入内网端口，默认 80。安装后执行 `sudo featherpanel` 再次打开菜单。菜单更新及 `sudo featherpanel update` 会查询最新正式版；自动化安装使用 `--install`，指定端口追加 `--port 18081`。

GitHub 直连慢时，可以通过第三方加速下载菜单入口：

```bash
curl -fL --proto '=https' --proto-redir '=https' https://gh-proxy.com/https://github.com/Babala524/-/releases/latest/download/install-online.sh -o feather-install-online.sh && sudo bash feather-install-online.sh
```

`--line auto` 依次尝试 GitHub、gh-proxy.com、ghfast.top，每条线路最多两次；也可指定 `--line direct`、`--line gh-proxy.com` 或 `--line ghfast.top`。指定单条线路时失败直接报错。下载显示进度，连接超时或持续低速会结束本次尝试；安装显示阶段和失败位置。Node.js 随发布包通过所选线路获取；系统软件源和 Valve 下载不受 GitHub 加速线路影响。加速站由第三方运营，只用于公开附件，不保证可用性；需要仅访问官方服务时选择 `direct`。

指定版本时下载对应标签的入口，再直接运行；从 v2026.10.23.1 起支持 `--version 标签` 配合版本元数据。缺失基础工具、首次准备功能依赖及安装游戏仍需访问系统软件源和 Valve；已有 Docker 数据不会自动迁移，80 被占用时安装停止。SHA-256 用于核对发布包，维护者必须保护 GitHub 仓库与发布账号。

在线入口的 `--check` 会先补齐下载所需的 curl、证书和 tar，下载并校验部署包，然后调用原生脚本的环境检查；不需要 Python。要完全不安装工具，请在已有完整包内运行 `bash install.sh --check`。

## 本次验证范围（2026-10-23）

Linux 后端 156 项测试全部通过，包含版本目录链接启动、原运行世界选择保留及停服失败中止更新。Debian 12、干净 Ubuntu 24.04 隔离环境验证了安装依赖、面板启动、重复安装、密钥保留和重启；Ubuntu 额外验证停止后重新启动、普通账号在 NoNewPrivileges 下使用独立 screen 目录。SteamCMD 官方下载曾成功，也遇到网络超时；Ubuntu 生命周期验证复用了已下载的官方启动文件。游戏服务端需联网另行下载，速度取决于软件源及 Valve 网络。

隔离环境中的 systemctl 使用测试替身，实际启动的是普通账号的 Node 进程；Ubuntu 主机上通过 systemd-analyze 校验了服务文件，但尚未完成真实 systemd 开机启动、完整原生开服与重启云服验证。Ubuntu 22.04、Debian 13 尚未实机验证。现有 Docker 云服保持原部署运行。

在线脚本在隔离环境验证了菜单分发、失败后返回菜单、参数传递、自动线路切换、指定线路失败、内置版本跳过元数据、强制刷新、校验失败和路径穿越拒绝。2026-10-23 已从当前云服通过两条加速线路取得旧版公开安装入口；GitHub 直连此前超时。完整原生开服与真实 systemd 生命周期仍需独立云服验证。

2026-10-23 按需依赖版：干净 Ubuntu 24.04 隔离环境在无 Python、screen、系统 Node 的情况下，使用随包 Node 启动面板，基础工具齐全后约 4～7 秒（不含下载部署包及补基础工具）。随后真实安装 Python、Pillow、字体、screen、32/64 位游戏运行库并下载 SteamCMD，重复检查均复用；Valve 首次曾超时，已增加三次重试。Debian 12 隔离安装和重复安装验证通过。systemd 单元通过语法/依赖检查；测试用本地桥接模拟 socket activation，未在真实 systemd 下完成全部生命周期验证。
