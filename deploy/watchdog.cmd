@echo off
REM ============================================================
REM FeedWatch MCP — 看护脚本（每 5 分钟由计划任务触发）
REM
REM 作用：Node 崩溃 / 被误杀 / 内存泄漏卡死后自动拉起。
REM 幂等：服务正常运行时什么都不做。
REM ============================================================
setlocal

set FW_PORT=3001
set FW_HEALTH=http://127.0.0.1:%FW_PORT%/health

REM 用 PowerShell 探测 /health（服务器无 Python，curl.exe 在部分版本
REM 的 Windows 上对 localhost 也会走代理，故用 .NET 的 HttpClient）
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -Uri '%FW_HEALTH%' -TimeoutSec 5 -UseBasicParsing; exit 0 } catch { exit 1 }"

if %ERRORLEVEL%==0 (
    echo [%DATE% %TIME%] 健康检查正常，无需重启。
    exit /b 0
)

echo [%DATE% %TIME%] 健康检查失败，尝试重新拉起 FeedWatch Node...
REM 先结束可能残留但已卡死的 node 进程（只杀本项目目录下的）
for /f "tokens=2 delims=," %%p in ('wmic process where "name='node.exe' and CommandLine like '%%FeedWatch%%'" get ProcessId /value 2^>nul ^| find "="') do (
    set PID=%%p
)
if defined PID (
    echo   结束残留进程 PID=%PID%
    taskkill /F /PID %PID% >nul 2>&1
)

schtasks /run /tn "FeedWatchNode" 2>&1
echo [%DATE% %TIME%] 已触发计划任务重启。
timeout /t 5 /nobreak >nul
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -Uri '%FW_HEALTH%' -TimeoutSec 5 -UseBasicParsing; Write-Host ('   重启后健康检查: ' + $r.StatusCode) } catch { Write-Host ('   重启后仍失败: ' + $_.Exception.Message) }"