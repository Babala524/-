# Ubuntu / Debian 快速部署

解压完整发布包，进入包含 `install.sh` 的目录：

```bash
sudo bash install.sh
```

支持 x86_64 Ubuntu 22.04/24.04、Debian 12/13，要求系统使用 systemd。脚本自动安装 Python、Pillow、screen、游戏 32/64 位运行库、中文字体、独立的 Node.js 24 和 SteamCMD，创建普通服务账号与开机启动服务。首次安装需要访问系统软件源、Node.js 和 Valve 下载服务器；不会立即下载几 GB 的游戏文件，安装游戏可在面板顶部“更新游戏”中操作。

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

维护者需将 `install-online.sh`、`FeatherPanel-native.tar.gz`、`FeatherPanel-native.tar.gz.sha256` 三个文件上传到同一 GitHub Release。已在本地工作区生成这三个发布文件。对外发布时使用固定文件名，版本由 Release 标签区分。

项目仓库为 `Babala524/-`。发布版本提供以下在线安装入口；需要仓库的 Release 已上传三个发布文件后才能使用：

```bash
curl -fL --proto '=https' --proto-redir '=https' https://github.com/Babala524/-/releases/latest/download/install-online.sh -o feather-install-online.sh && sudo bash feather-install-online.sh --repo Babala524/-
```

指定端口追加 `--port 18081`。指定版本时，首次脚本下载也应使用 `releases/download/版本标签/install-online.sh`，并给脚本传入 `--version 版本标签`。在线安装仍需访问 GitHub、系统软件源、Node.js 和 Valve；已有 Docker 数据不会自动迁移，80 被占用时安装停止。SHA-256 用于核对发布包，维护者必须保护 GitHub 仓库与发布账号。

在线入口的 `--check` 会先安装下载所需工具、下载并校验部署包，然后调用原生脚本的环境检查；要完全不安装工具，请在已有完整包内运行 `bash install.sh --check`。

## 本次验证范围（2026-10-23）

Linux 后端 156 项测试全部通过，包含版本目录链接启动、原运行世界选择保留及停服失败中止更新。Debian 12、干净 Ubuntu 24.04 隔离环境验证了安装依赖、面板启动、重复安装、密钥保留和重启；Ubuntu 额外验证停止后重新启动、普通账号在 NoNewPrivileges 下使用独立 screen 目录。SteamCMD 官方下载曾成功，也遇到网络超时；Ubuntu 生命周期验证复用了已下载的官方启动文件。游戏服务端需联网另行下载，速度取决于软件源及 Valve 网络。

隔离环境中的 systemctl 使用测试替身，实际启动的是普通账号的 Node 进程；Ubuntu 主机上通过 systemd-analyze 校验了服务文件，但尚未完成真实 systemd 开机启动、完整原生开服与重启云服验证。Ubuntu 22.04、Debian 13 尚未实机验证。现有 Docker 云服保持原部署运行。

在线脚本已在隔离环境用模拟 GitHub 下载验证自动解析版本、参数传递、校验失败拒绝安装及路径穿越拒绝。2026-10-23 已发布 GitHub 正式版本 v2026.10.23，公开脚本、校验文件和完整 73 MB 部署包均已下载并核验；当前云服访问 GitHub 超时，未完成该云服直接从公开地址执行安装的端到端验证。
