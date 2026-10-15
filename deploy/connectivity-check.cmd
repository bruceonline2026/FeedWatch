REM ============================================================
REM FeedWatch MCP — 上线前连通性自检（必须在目标服务器上跑）
REM
REM ★ 这是上线与否的「一票否决项」。
REM   本产品会替用户抓取任意 URL。若服务器抓不到境外源，
REM   产品的核心价值（监控 GitHub release / 国外新闻站 RSS）直接失效。
REM
REM 用法（管理员 cmd）：
REM   cd C:\inetpub\FeedWatch\deploy
REM   connectivity-check.cmd
REM ============================================================
@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ============================================================
echo   FeedWatch 出网连通性自检
echo   目标服务器：47.116.215.156
echo   时间：%DATE% %TIME%
echo ============================================================
echo.

REM ---------- 1. 基础连通性 ----------
echo [1/4] 基础网络连通性
echo   - DNS 解析：
nslookup github.com 8.8.8.8 2>&1 | findstr /i "address 名称 Name" | findstr /v "8.8.8.8"
if errorlevel 1 (echo     ✗ DNS 解析异常) else (echo     ✓ DNS 可用)
echo   - 国内站可达性：
curl.exe -sS -o NUL -w "     people.com.cn  HTTP %%{http_code}  耗时 %%{time_total}s`n" --max-time 10 http://www.people.com.cn/rss/politics.xml 2>&1
echo.

REM ---------- 2. 境外源（决定性测试）----------
echo [2/4] 境外 feed 源可达性  ← 决定产品是否可用
echo.

REM 用 Node 直接跑本项目的抓取代码，而不是用 curl ——
REM 因为 curl 通不代表 Node 通（代理/证书/DNS 解析器都可能是 Node 特有配置）
echo   用项目自身的 safeFetch 测试（最接近真实行为）：
"%ProgramFiles%\nodejs\node.exe" ..\deploy\connectivity-probe.mjs 2>&1
set FW_PROBE_RESULT=%ERRORLEVEL%
echo.

REM ---------- 3. 出网代理设置 ----------
echo [3/4] 代理与DNS 配置
echo   - HTTP_PROXY : %HTTP_PROXY%
echo   - HTTPS_PROXY: %HTTPS_PROXY%
echo   - NODE_TLS_REJECT_UNAUTHORIZED: %NODE_TLS_REJECT_UNAUTHORIZED%
echo.

REM ---------- 4. 结论 ----------
echo [4/4] 结论
if %FW_PROBE_RESULT%==0 (
    echo   ★ 通过 —— 境外源可正常抓取，可以上线。
) else (
    echo   ✗ 不通过 —— 服务器无法抓取境外 feed。
    echo.
    echo   ══════════════════════════════════════════════════════
    echo   必须先做以下三选一，否则产品核心价值失效：
    echo.
    echo   [方案 1] 服务器配置出网代理（推荐，代码已支持，无需改代码）
    echo     在 run-node.cmd 里加两行：
    echo       set HTTPS_PROXY=http://用户名:密码@代理地址:端口
    echo       set HTTP_PROXY=http://用户名:密码@代理地址:端口
    echo     已实测：HTTPS 走 CONNECT 隧道、HTTP 走绝对 URI 均正常，
    echo     且代理模式下 SSRF 防护仍然生效（内网/云元数据地址照样被拦）。
    echo     注意：node:http 本身不读这些变量，是本项目显式读取的。
    echo.
    echo   [方案 2] 目标客户只抓国内源
    echo     产品价值大幅收窄：GitHub release / 国外新闻 RSS 全部不可用。
    echo     需同步调整 README 与 MCP 工具描述，避免客户预期落空。
    echo.
    echo   [方案 3] 抓取与推送分离（本机抓 + 结果推送）
    echo     在本机/境外 VPS 跑抓取器，把变更推给服务器。
    echo     架构改动最大，但境外出网问题彻底解决。
    echo   ══════════════════════════════════════════════════════
)
echo.
pause