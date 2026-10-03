@echo off
rem Doble clic: abre el panel del servidor de Scan-bar (un botón para encender y apagar).
chcp 65001 >nul
cd /d "%~dp0"
title Scan-bar - servidor (no cierres esta ventana mientras lo uses)
where node >nul 2>nul
if errorlevel 1 (
  echo Necesitas Node.js 22 o superior: https://nodejs.org  ^(descarga la version LTS e instalala^)
  pause
  exit /b 1
)
rem La primera vez, npm run servidor instala lo necesario (servidor/iniciar.mjs).
call npm run servidor
pause
