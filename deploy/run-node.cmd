@echo off
REM ============================================================
REM FeedWatch MCP — Node 进程启动包装脚本
REM 由 install-task.cmd 创建的计划任务调用。
REM
REM ★ 本文件【不含任何密钥】，可直接进代码仓库。
REM   凭据配置见下方「凭据配置」段，推荐用机器级环境变量（不落盘）。
REM ============================================================
setlocal

cd /d C:\inetpub\FeedWatch

REM ⚠️ 仅监听 127.0.0.1。改成 0.0.0.0 会让 3001 端口直接暴露公网，
REM    绕过 IIS 的 TLS 终止、访问日志与 WAF —— 严重安全隐患。
set HOST=127.0.0.1
set PORT=3001
set PUBLIC_URL=https://api.tiici.com

REM ⚠️ 凭据配置：两种方式，二选一，**强烈建议用方式 A（不落盘）**
REM
REM  【方式 A｜机器级环境变量，推荐】
REM    在服务器上执行一次（管理员 cmd）：
REM      setx /M FEEDWATCH_BOOTSTRAP_KEY "<64位随机串>"
REM      setx /M HTTPS_PROXY "http://user:pass@proxy.host:port"
REM      setx /M HTTP_PROXY  "http://user:pass@proxy.host:port"
REM
REM    setlocal 不会屏蔽已存在的机器级变量，它们会自动继承并传给 node.exe。
REM    本文件因此**不需要**再set 这几个变量，也不会碰机器上的值。
REM    好处：密码不落盘、不进仓库；轮换只需 setx + 重启计划任务。
REM
REM  【方式 B｜写死在本文件】
REM    仅当运维不便设机器级变量时用。⚠️ 密钥与代理密码会留在磁盘上，
REM    且本文件一旦被 git 跟踪就会泄露 —— 见 .gitignore 已排除 deploy/*.local.cmd
REM    如必须用方式 B，请把真实值写在 run-node.local.cmd（已加入 .gitignore），
REM    并在下方 source 它的内容。
REM
REM 引导密钥：必须 >= 32 字符，建议 64 位随机串
REM 生成方式（PowerShell）：
REM   -join ((1..64) | ForEach-Object { '0123456789abcdef'[int](Get-Random -Max 16) })

REM ── 进程身份说明（部署时不要搞错）─────────────────────────
REM本脚本由【计划任务服务】(Schedule 服务, /ru SYSTEM) 启动，
REM   不是由 IIS 应用程序池(w3wp.exe) 启动。
REM   IIS 只做反向代理：把 https://api.tiici.com 转到 127.0.0.1:3001。
REM
REM   ⇒ 因此 IIS 的「应用程序池身份 / loadUserProfile」与本服务【无关】，
REM     不存在「IIS 读不到机器级环境变量」的问题。
REM   ⇒ 机器级变量（setx /M）对本进程必然可见。
REM
REM ── 仍然提供兜底自检 ──
REM 万一计划任务服务在 setx 之前就启动过（极少见），机器级变量可能读不到。
REM 下面把关键值打印出来（脱敏），供 status-task.cmd 核对。
REM 若存在本地私有配置文件则加载（该文件已被 .gitignore 排除，不会进仓库）
if exist "%~dp0run-node.local.cmd" call "%~dp0run-node.local.cmd"

REM 跨域白名单（逗号分隔）—— 非敏感配置，可直接写死
if "%ALLOWED_ORIGINS%"=="" set ALLOWED_ORIGINS=https://tiici.com,https://www.tiici.com

if not exist logs mkdir logs

REM 启动前自检：缺引导密钥就拒绝启动，避免上线后才发现谁都拿不到凭据
if "%FEEDWATCH_BOOTSTRAP_KEY%"=="" (
    echo [feedwatch] 错误：未配置 FEEDWATCH_BOOTSTRAP_KEY，拒绝启动。 >&2
    echo   机器级配置：setx /M FEEDWATCH_BOOTSTRAP_KEY "^<64位随机串^>"   >&2
    echo   或写入 deploy\run-node.local.cmd 后重启本任务。>&2
    exit /b 1
)

REM ── 凭据可见性自检（只报状态，绝不打印密钥本身）──────────────
REM 用途：setx /M 之后若计划任务服务未重启，变量可能读不到。
REM 这种情况不会让服务异常，只会让引导密钥静默缺失 —— 所以主动打印状态。
REM ⚠️ 只回答「有没有」，不输出内容也不谎报长度。
echo [feedwatch] 自检：引导密钥=已配置（内容与长度不在此显示）
if "%HTTPS_PROXY%"=="" (
    echo [feedwatch] 自检：出网代理=未配置（走直连）
) else (
    echo [feedwatch] 自检：出网代理=已配置
)

echo [feedwatch] 启动中...
"C:\Program Files\nodejs\node.exe" src\server.js >> logs\stdout.log 2>> logs\stderr.log
exit /b %ERRORLEVEL%