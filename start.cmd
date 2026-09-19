@echo off
cd /d "%~dp0"
echo CS2 Match Lab
echo Open http://localhost:3210 after the server starts.
node --disable-warning=ExperimentalWarning src/server.js
pause
