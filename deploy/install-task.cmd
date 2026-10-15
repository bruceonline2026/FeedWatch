@echo off
REM ============================================================
REM FeedWatch MCP — Windows 计划任务启动/停止脚本
REM
REM 用途：服务器无 pm2 / systemd，用计划任务常驻 Node 进程，
REM       并在崩溃或被kill 后自动拉起。
REM
REM 用法（管理员 cmd）：
REM   install-task.cmd    安装计划任务（含崩溃重启 + 开机自启）
REM   start-task.cmd      手动启动
REM   stop-task.cmd       手动停止
REM   status-task.cmd     查看状态
REM
REM 关键设计：
REM   · 崩溃重启：schtasks /create /sc onstart 与 /ri 配合，
REM     Node 崩溃后由任务计划程序按重复间隔再次拉起。
REM     注意 /sc onstart 只在开机时跑一次，因此额外用
REM     /sc minute /mo 5 的看护任务保证「进程死掉后 5 分钟内复活」。
REM   · 日志：stdout/stderr 重定向到 logs 目录，便于排查。
REM ============================================================

setlocal enabledelayedexpansion

REM ---- 配置区（部署时按实际情况修改）----
set FW_DIR=C:\inetpub\FeedWatch
set FW_TASK=FeedWatchNode
set FW_WATCH=FeedWatchWatchdog
set FW_NODE=C:\Program Files\nodejs\node.exe
set FW_URL=https://api.tiici.com
REM 引导密钥：必须是 32 字符以上，且只留在这台机器上
set FW_BOOTSTRAP=REPLACE_WITH_A_RANDOM_64_CHAR_STRING
REM ------------------------------------

set FW_LOG=%FW_DIR%\logs

if "%1"=="install-task" goto install
if "%1"=="start-task" goto start
if "%1"=="stop-task" goto stop
if "%1"=="status-task" goto status

echo 用法：install-task.cmd ^| start-task.cmd ^| stop-task.cmd ^| status-task.cmd
goto :eof

:install
echo [1/4] 创建目录
if not exist "%FW_LOG%" mkdir "%FW_LOG%"

echo [2/4] 停掉可能存在的旧任务
schtasks /delete /tn "%FW_TASK%" /f >nul 2>&1
schtasks /delete /tn "%FW_WATCH%" /f >nul 2>&1

echo [3/4] 注册主任务（开机自启 + 崩溃重启）
REM /tr 传环境变量的坑：schtasks 的 /tr 不支持直接写 env 前缀，
REM 所以用一个包装 .cmd 来设置环境变量后再启动 node。
schtasks /create /tn "%FW_TASK%" /tr "%FW_DIR%\run-node.cmd" ^
  /sc onstart /ru SYSTEM /rl HIGHEST /f

echo [4/4] 注册看护任务（每 5 分钟检查并拉起）
schtasks /create /tn "%FW_WATCH%" /tr "%FW_DIR%\watchdog.cmd" ^
  /sc minute /mo 5 /ru SYSTEM /rl HIGHEST /f

echo.
echo ✅ 安装完成。
echo    主任务  ：%FW_TASK%   （开机自启）
echo    看护任务：%FW_WATCH%   （每 5 分钟拉起）
echo    日志目录：%FW_LOG%
echo.
echo ⚠️ 上线前请务必先编辑 %FW_DIR%\run-node.cmd，
echo    把 FEEDWATCH_BOOTSTRAP_KEY 换成真实随机值。
goto :eof

:start
schtasks /run /tn "%FW_TASK%" 2>&1
echo 已触发启动，3 秒后查看 /health确认
timeout /t 3 /nobreak >nul
"%FW_NODE%" -e "fetch('http://127.0.0.1:3001/health').then(r=>r.text()).then(t=>console.log('health:',t)).catch(e=>console.log('health失败:',e.message))"
goto :eof

:stop
schtasks /end /tn "%FW_TASK%" 2>&1
echo 已停止。注意：看护任务会在 5 分钟内重新拉起它，
echo 如需彻底停止请先禁用看护任务：
echo   schtasks /change /tn "%FW_WATCH%" /disable
goto :eof

:status
echo === 任务状态 ===
schtasks /query /tn "%FW_TASK%" /fo LIST /v 2>&1 | findstr /i "Status TaskName Next Run"
echo.
echo === 进程 ===
tasklist /fi "imagename eq node.exe" 2>&1
echo.
echo === 端口 3001（应只监听 127.0.0.1）===
netstat -ano | findstr ":3001"
echo.
echo === 凭据可见性（只看有没有，不显示内容）===
REM说明：Node 由【计划任务服务】以 SYSTEM 身份启动，不是 IIS 应用程序池，
REM     所以 IIS 的 loadUserProfile 与本服务无关。机器级变量（setx /M）应当可见。
REM     若下面显示「未读到」，说明 setx 之后计划任务服务未重启，
REM     请改用方式 B：把凭据写进 deploy\run-node.local.cmd。
powershell -NoProfile -Command ^
  "$b=[Environment]::GetEnvironmentVariable('FEEDWATCH_BOOTSTRAP_KEY','Machine');" ^
  "if($b){Write-Host ('引导密钥(机器级): 已读取，长度 ' + $b.Length + '位✓')}else{Write-Host '引导密钥(机器级): 未读到'}" ^
  "$p=[Environment]::GetEnvironmentVariable('HTTPS_PROXY','Machine');" ^
  "if($p){Write-Host '出网代理(机器级):   已配置'}else{Write-Host '出网代理(机器级):   未配置'}"
echo.
echo === 最近日志 ===
if exist "%FW_LOG%\stdout.log" powershell -NoProfile -Command "Get-Content '%FW_LOG%\stdout.log' -Tail 20"
goto :eof