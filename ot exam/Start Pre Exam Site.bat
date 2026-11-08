@echo off
setlocal
cd /d "%~dp0"

if not exist "target\pre-exam-site-1.0.0-jar-with-dependencies.jar" (
  echo Pre Exam Site has not been built yet.
  echo Install Maven, open this folder in a terminal, and run: mvn package
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$r = Test-NetConnection -ComputerName 127.0.0.1 -Port 8080 -WarningAction SilentlyContinue -InformationLevel Quiet; if (-not $r) { Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', 'java -jar target\pre-exam-site-1.0.0-jar-with-dependencies.jar') -WorkingDirectory '%~dp0' }; Start-Process 'http://localhost:8080'"
if errorlevel 1 (
  echo Could not start the site. Make sure Java is installed and try again.
  pause
)
endlocal
