@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
call :install "%~1"
set "DAFY_INSTALL_RESULT=%errorlevel%"
if not "%DAFY_INSTALL_RESULT%"=="0" (
    echo.
    echo [错误] 安装中断，请保留上方报错，隐去 Key 和密码后反馈。
    pause
)
exit /b %DAFY_INSTALL_RESULT%

:install
cd /d "%~dp0"
title 大肥鱼 - 首次安装
echo 首次安装：本地重建环境，随后填写模型与后台凭证。
echo 插件与人格导入需要联网；脚本不会停止已有后台。

if not exist "runtime\python\python.exe" goto :incomplete
if not exist "astrbot\.astrbot" goto :incomplete
if not exist "astrbot\data\cmd_config.json" goto :incomplete
if not exist "scripts\requirements.lock.txt" goto :incomplete
if not exist "scripts\first_run.py" goto :incomplete
rem 离线验证只允许在尚无 venv 的新目录执行，不写账号、不启动服务。
if /i "%~1"=="--verify-offline" (
    if exist "astrbot\venv" (
        echo [错误] 离线首装验证要求无 venv 的新目录，已有环境未被修改。
        exit /b 1
    )
    goto :environment
)
rem 在修改 venv 和配置前拒绝已有服务，避免干扰当前机器人。
for %%p in (6099 6185 6198 6199) do (
    call :port_open %%p
    if not errorlevel 1 (
        echo [错误] %%p 已被占用。请使用空闲的测试机器或先自行停止相应服务。
        exit /b 1
    )
)

:environment
set "VENV=%~dp0astrbot\venv"
set "EXPECT=%~dp0runtime\python"
if not exist "%VENV%\Scripts\python.exe" goto :make_venv
"runtime\python\python.exe" -B "scripts\check_venv.py" --venv "%VENV%" --runtime "%EXPECT%"
if errorlevel 1 exit /b 1
goto :deps

:make_venv
if exist "%VENV%" (
    echo [错误] venv 目录存在但环境不完整，请保留后从干净包重新解压。
    exit /b 1
)
echo [1/5] 在当前目录创建 Python 环境...
"runtime\python\python.exe" -B -m venv "%VENV%"
if errorlevel 1 exit /b 1

:deps
echo [2/5] 按哈希锁离线安装依赖...
"astrbot\venv\Scripts\python.exe" -m pip install --no-index --only-binary=:all: --require-hashes --find-links wheels -r "scripts\requirements.lock.txt" --quiet
if errorlevel 1 exit /b 1
"astrbot\venv\Scripts\python.exe" -m pip check
if errorlevel 1 exit /b 1
rem 应用已校验的回复节奏支持，保持轮子哈希锁不变。
"runtime\python\python.exe" -I -S -B -X utf8 "scripts\voice-order-fix\apply_voice_order.py" --bundle "%~dp0." --apply
if errorlevel 1 exit /b 1
rem 仅验证离线环境，不填凭证、不初始化、不启动任何服务。
if /i "%~1"=="--verify-offline" exit /b 0

echo [3/5] 填写本机配置。首次后台密码至少8位，含大小写字母和数字。
set "DAFY_DEEPSEEK_KEY="
set /p DAFY_DEEPSEEK_KEY=DeepSeek API Key:
set "DAFY_OWNER="
set /p DAFY_OWNER=主人 QQ:
set "DAFY_SF_KEY="
set /p DAFY_SF_KEY=硅基流动 Key（可留空使用本地向量）:
set "DAFY_VOLC_ID="
set /p DAFY_VOLC_ID=豆包 APP ID（可留空）:
set "DAFY_VOLC_TOKEN="
set /p DAFY_VOLC_TOKEN=豆包 Access Token（可留空）:
if not defined DAFY_DASHBOARD_PASSWORD set /p DAFY_DASHBOARD_PASSWORD=AstrBot 后台密码:
if not defined DAFY_DEEPSEEK_KEY exit /b 1
if not defined DAFY_OWNER exit /b 1
if not defined DAFY_DASHBOARD_PASSWORD exit /b 1
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
"astrbot\venv\Scripts\python.exe" -X utf8 "scripts\apply_config.py" --initialize-if-empty
if errorlevel 1 exit /b 1

echo [4/5] 启动向量服务和 AstrBot...
call :start_backend
if errorlevel 1 exit /b 1
echo [5/5] 联网导入插件与人格...
"astrbot\venv\Scripts\python.exe" -X utf8 "scripts\apply_config.py" --import-only
if errorlevel 1 exit /b 1
echo 安装完成。运行启动.bat启动本地向量与QQ扫码窗口。
echo 后台 http://127.0.0.1:6185 ，账号 astrbot，密码为你刚才设置的密码。
pause
exit /b 0

:port_open
"runtime\python\python.exe" -B -c "import socket,sys; s=socket.socket(); s.settimeout(.4); code=s.connect_ex(('127.0.0.1',int(sys.argv[1]))); s.close(); sys.exit(0 if code==0 else 1)" %1
exit /b %errorlevel%

:start_backend
setlocal DisableDelayedExpansion
set "DAFY_DEEPSEEK_KEY="
set "DAFY_SF_KEY="
set "DAFY_VOLC_ID="
set "DAFY_VOLC_TOKEN="
set "DAFY_DASHBOARD_PASSWORD="
start "Embedding" /min /d "%~dp0astrbot" "%~dp0astrbot\venv\Scripts\python.exe" -X utf8 "%~dp0astrbot\tools\embed_server.py" --port 6198
if errorlevel 1 ( endlocal & exit /b 1 )
for /l %%i in (1,1,60) do (
    "runtime\python\python.exe" -B -X utf8 -c "import json,urllib.request,sys; d=json.load(urllib.request.urlopen('http://127.0.0.1:6198/health',timeout=2)); sys.exit(0 if d.get('ok') is True and d.get('model_loaded') is True and d.get('dimensions')==512 and d.get('model')=='bge-small-zh-v1.5' else 1)" 2>nul
    if not errorlevel 1 goto :embedding_ready
    timeout /t 1 /nobreak >nul
)
endlocal
echo [错误] 本地向量服务未就绪，未继续导入记忆；请检查模型文件和服务日志。
exit /b 1

:embedding_ready
call :port_open 6185
if not errorlevel 1 ( endlocal & exit /b 1 )
start "" /min /d "%~dp0astrbot" "%~dp0astrbot\venv\Scripts\astrbot.exe" run
if errorlevel 1 ( endlocal & exit /b 1 )
for /l %%i in (1,1,60) do (
    call :port_open 6185
    if not errorlevel 1 ( endlocal & exit /b 0 )
    timeout /t 1 /nobreak >nul
)
endlocal
echo [错误] AstrBot未按时监听，请检查安装目录内日志。
exit /b 1

:incomplete
echo [错误] 安装包不完整，请重新解压。缺少运行时、启动标记、模板或锁文件。
exit /b 1
