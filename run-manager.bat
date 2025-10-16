@echo off
setlocal
chcp 65001 >nul
title Charles Capture — Manager
rem Перейти в папку скрипта (корень проекта)
cd /d "%~dp0"
color 0A

rem Проверка наличия Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js не найден. Установи Node 18+ и перезапусти батник.
  pause
  exit /b 1
)

rem Установка зависимостей при первом запуске (если node_modules пуст или отсутствует)
if not exist "node_modules" (
  echo [INFO] Устанавливаю зависимости...
  call npm ci || call npm install
  if errorlevel 1 (
    echo [ERROR] Установка зависимостей не удалась.
    pause
    exit /b 1
  )
)

echo [INFO] Запуск менеджера...
node manager.js %*
echo.
pause
