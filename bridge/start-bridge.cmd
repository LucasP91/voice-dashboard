@echo off
rem Starts the Voice Dashboard's Claude bridge. Leave the window open (minimise it).
title Voice Dashboard - Claude bridge
cd /d "%~dp0"
node claude-bridge.mjs
pause
